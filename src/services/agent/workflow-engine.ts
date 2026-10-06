import { getBookingPolicyWindow } from '../../utils/booking-policy';

export type OperationKind = 'new_booking' | 'reschedule' | 'cancellation' | 'addon_change';
export type OperationState = 'selecting_target' | 'collecting' | 'clarifying' | 'checking_availability'
  | 'awaiting_confirmation' | 'payment_open' | 'applying' | 'reconciling' | 'completed' | 'withdrawn' | 'expired';
export type InformationTopic = 'name' | 'booking' | 'payment' | 'addons' | 'invoice';
export type WorkflowSlots = Readonly<{ name?: string; recipientName?: string; service?: string; date?: string; time?: string }>;
export type WorkflowBooking = Readonly<{
  id: string; customerId: string; service: string; date: string; time: string; dateTimeIso: string;
  status: 'confirmed' | 'cancelled'; paidAmount: number;
}>;
export type WorkflowOperation = Readonly<{
  id: string; customerId: string; kind: OperationKind; state: OperationState;
  revision: number; targetBookingId?: string; slots: WorkflowSlots; expiresAt?: number;
  sameDayOnly?: boolean;
  addonsDecided?: boolean;
  forSomeoneElse?: boolean;
}>;
export type WorkflowBlock = Readonly<{
  id: string; customerId: string; intendedKind: OperationKind;
  conflictingOperationId: string; reason: string;
}>;
export type WorkflowSnapshot = Readonly<{
  status: 'ready' | 'unavailable' | 'inconsistent'; customerId: string;
  customerName?: string; bookings: readonly WorkflowBooking[];
  operation: WorkflowOperation | null; block: WorkflowBlock | null;
  externalEffect: 'none' | 'pending' | 'unknown'; now: number;
  packages?: readonly Readonly<{ service: string; deposit: number }>[];
  proposal?: WorkflowProposal | null;
  clarification?: WorkflowClarification | null;
  availability?: Readonly<{
    operationId: string; operationRevision: number; date: string; service: string; excludeBookingId?: string;
    status: 'available' | 'unavailable' | 'closed' | 'failed'; slots: readonly string[];
  }> | null;
}>;
export type WorkflowProposal = Readonly<{
  id: string; operationId: string; operationRevision: number; kind: OperationKind;
  targetBookingId?: string; slots: WorkflowSlots; amount?: number;
  presentedTurnId: string; delivered: boolean; expiresAt?: number;
  rescheduleForfeitsDeposit?: boolean; cancellationRefundEligible?: boolean;
}>;
export type WorkflowClarification = Readonly<{
  id: string; operationId: string; operationRevision: number; candidateTime: string;
  presentedTurnId: string; delivered: boolean;
}>;
export type WorkflowEvent = Readonly<{
  turnId: string; platform: 'whatsapp' | 'web' | 'instagram' | 'facebook';
  intent: 'information' | 'start' | 'provide_slots' | 'clarify' | 'confirm' | 'availability'
    | 'availability_result' | 'accept_clarification' | 'withdraw' | 'provider_failure' | 'unknown';
  topic?: InformationTopic; operationKind?: OperationKind; targetBookingId?: string;
  slots?: WorkflowSlots; slotSource?: 'customer' | 'model' | 'reference' | 'rejected';
  explicitConsent?: boolean; proposalId?: string; clarificationId?: string; rawTime?: string; sameDayOnly?: boolean;
  addonsDecision?: 'declined' | 'selected'; forSomeoneElse?: boolean;
}>;
export type WorkflowCommand = Readonly<{
  kind: 'read_information'; topic: InformationTopic; customerId: string; bookingId?: string;
}> | Readonly<{
  kind: 'check_availability'; customerId: string; operationId: string; operationRevision: number;
  service: string; date: string; excludeBookingId?: string;
}> | Readonly<{
  kind: 'present_proposal' | 'request_time_clarification'; customerId: string; operationId: string; evidenceId: string;
}> | Readonly<{
  kind: 'initiate_payment' | 'apply_reschedule' | 'apply_cancellation'; customerId: string; operationId: string;
  expectedRevision: number; bookingId?: string; proposalId: string; idempotencyKey: string;
}>;
export type WorkflowDecision = Readonly<{
  id: string; outcome: 'information_requested' | 'blocked' | 'reconciliation_pending' | 'clarification_requested' | 'failed'
    | 'operation_started' | 'input_requested' | 'availability_requested' | 'availability_answered' | 'proposal_required'
    | 'confirmation_accepted' | 'withdrawal_requested' | 'operation_expired';
  template: 'information' | 'blocked' | 'reconcile' | 'clarify_intent' | 'state_unavailable' | 'target_selection'
    | 'missing_field' | 'show_slots' | 'availability_failed' | 'no_slots' | 'confirm_time' | 'proposal'
    | 'consent_required' | 'action_pending' | 'operation_withdrawn' | 'operation_expired';
  commands: readonly WorkflowCommand[];
  requiredInput: 'intent' | 'target' | 'service' | 'name' | 'recipient' | 'addons' | 'date' | 'time' | 'clarification' | 'confirmation' | null;
  expectedOperationId: string | null; expectedRevision: number | null;
  transition: 'retain' | 'begin' | 'advance' | 'block' | 'expire' | 'withdraw'; modelMayChangeWorkflow: false; reason: string;
  nextOperation?: WorkflowOperation;
  nextProposal?: WorkflowProposal | null;
  nextClarification?: WorkflowClarification | null;
  availableSlots?: readonly string[];
  nextBlock?: WorkflowBlock;
}>;

function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

function validTime(time: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
}

const terminalStates: readonly OperationState[] = ['completed', 'withdrawn', 'expired'];
const operationKinds: readonly OperationKind[] = ['new_booking', 'reschedule', 'cancellation', 'addon_change'];
const operationStates: readonly OperationState[] = ['selecting_target', 'collecting', 'clarifying', 'checking_availability',
  'awaiting_confirmation', 'payment_open', 'applying', 'reconciling', ...terminalStates];

function sameSlots(first: WorkflowSlots, second: WorkflowSlots): boolean {
  return (['name', 'recipientName', 'service', 'date', 'time'] as const).every(field => first[field] === second[field]);
}

export function decideWorkflow(snapshot: WorkflowSnapshot, event: WorkflowEvent,
  origin: 'customer' | 'system' | 'model'): WorkflowDecision {
  const decision = (outcome: WorkflowDecision['outcome'], template: WorkflowDecision['template'], reason: string,
    commands: readonly WorkflowCommand[] = [], requiredInput: WorkflowDecision['requiredInput'] = null): WorkflowDecision => ({
    id: `${event.turnId}:${outcome}`, outcome, template, reason, commands, requiredInput,
    expectedOperationId: snapshot.operation?.id || null, expectedRevision: snapshot.operation?.revision ?? null,
    transition: 'retain', modelMayChangeWorkflow: false,
  });
  if (snapshot.status !== 'ready') return decision('failed', 'state_unavailable', 'authoritative_snapshot_unavailable');
  if (!Number.isFinite(snapshot.now) || !event.turnId) return decision('failed', 'state_unavailable', 'invalid_clock_or_turn');
  if (snapshot.operation && snapshot.operation.customerId !== snapshot.customerId
    || snapshot.block && snapshot.block.customerId !== snapshot.customerId) {
    return decision('failed', 'state_unavailable', 'operation_ownership_mismatch');
  }
  if (snapshot.operation && (!operationKinds.includes(snapshot.operation.kind) || !operationStates.includes(snapshot.operation.state)
    || !Number.isInteger(snapshot.operation.revision) || snapshot.operation.revision < 0
    || snapshot.operation.slots.date && !validDate(snapshot.operation.slots.date)
    || snapshot.operation.slots.time && !validTime(snapshot.operation.slots.time))) {
    return decision('failed', 'state_unavailable', 'invalid_persisted_operation');
  }
  if (origin === 'model') return snapshot.block ? decision('blocked', 'blocked', snapshot.block.reason)
    : decision('clarification_requested', 'clarify_intent', 'model_suggestion_requires_validation', [], 'intent');
  if (origin !== 'customer' && !(origin === 'system' && ['availability_result', 'provider_failure'].includes(event.intent))) {
    return decision('failed', 'state_unavailable', 'event_origin_not_authorized');
  }
  if (origin === 'customer' && event.intent === 'availability_result') return decision('failed', 'state_unavailable', 'availability_requires_system_result');
  if (event.intent === 'information' && event.topic) {
    const bookingId = event.topic === 'name' ? undefined : event.targetBookingId || snapshot.operation?.targetBookingId;
    const owned = snapshot.bookings.filter(booking => booking.customerId === snapshot.customerId && booking.status === 'confirmed');
    if (bookingId && !owned.some(booking => booking.id === bookingId)) {
      return decision('failed', 'state_unavailable', 'booking_ownership_or_status_mismatch');
    }
    if (!bookingId && event.topic !== 'name' && owned.length > 1) {
      return decision('clarification_requested', 'target_selection', 'ambiguous_information_target', [], 'target');
    }
    return decision('information_requested', 'information', 'scoped_information_without_transition', [{
      kind: 'read_information', topic: event.topic, customerId: snapshot.customerId,
      ...(event.topic !== 'name' && (bookingId || owned.length === 1) ? { bookingId: bookingId || owned[0].id } : {}),
    }]);
  }
  if (snapshot.block) return decision('blocked', 'blocked', snapshot.block.reason);
  if (snapshot.externalEffect !== 'none') return decision('reconciliation_pending', 'reconcile', 'unresolved_external_effect');
  if (event.platform !== 'whatsapp' && event.platform !== 'web') {
    return decision('blocked', 'blocked', 'channel_cannot_mutate_bookings');
  }
  let operation = snapshot.operation && !terminalStates.includes(snapshot.operation.state) ? snapshot.operation : null;
  if (operation?.state === 'payment_open' || operation?.state === 'applying' || operation?.state === 'reconciling') {
    return decision('reconciliation_pending', 'reconcile', 'operation_has_pending_effect');
  }
  if (operation?.expiresAt !== undefined && operation.expiresAt <= snapshot.now) {
    return { ...decision('operation_expired', 'operation_expired', 'expired_operation_cannot_authorize_action'),
      transition: 'expire', nextOperation: { ...operation, state: 'expired', revision: operation.revision + 1 },
      nextProposal: null, nextClarification: null };
  }
  let transition: WorkflowDecision['transition'] = 'advance';
  if (event.intent === 'start') {
    if (!event.operationKind) return decision('clarification_requested', 'clarify_intent', 'missing_operation_kind', [], 'intent');
    if (operation && (operation.kind !== event.operationKind
      || event.targetBookingId && operation.targetBookingId && event.targetBookingId !== operation.targetBookingId)) {
      return { ...decision('blocked', 'blocked', 'competing_operation_requires_resolution'), transition: 'block',
        nextBlock: { id: `block:${snapshot.customerId}:${event.turnId}`, customerId: snapshot.customerId,
          intendedKind: event.operationKind, conflictingOperationId: operation.id, reason: 'competing_operation_requires_resolution' } };
    }
    if (!operation) {
      operation = { id: `operation:${snapshot.customerId}:${event.turnId}`, customerId: snapshot.customerId,
        kind: event.operationKind, state: event.operationKind === 'new_booking' ? 'collecting' : 'selecting_target',
        revision: 0, slots: event.operationKind === 'new_booking' && snapshot.customerName ? { name: snapshot.customerName } : {},
        sameDayOnly: event.sameDayOnly === true, forSomeoneElse: event.forSomeoneElse === true };
      transition = 'begin';
    }
  }
  if (!operation) return decision('clarification_requested', 'clarify_intent', 'no_active_operation', [], 'intent');
  const next = (patch: Partial<WorkflowOperation>): WorkflowOperation => ({ ...operation!, ...patch, revision: operation!.revision + 1 });
  if (event.intent === 'provider_failure' || event.intent === 'clarify' || event.intent === 'unknown') {
    return decision('clarification_requested', 'clarify_intent', 'operation_retained_without_new_input', [],
      operation.state === 'clarifying' ? 'clarification' : 'intent');
  }
  if (event.intent === 'withdraw') {
    if (!event.explicitConsent) return decision('clarification_requested', 'consent_required', 'withdrawal_requires_explicit_intent', [], 'confirmation');
    return { ...decision('withdrawal_requested', 'operation_withdrawn', 'withdraw_operation_not_booking'),
      transition: 'withdraw', nextOperation: next({ state: 'withdrawn' }), nextProposal: null, nextClarification: null };
  }
  const ownedBookings = snapshot.bookings.filter(booking => booking.customerId === snapshot.customerId && booking.status === 'confirmed'
    && Number.isFinite(Date.parse(booking.dateTimeIso)) && Date.parse(booking.dateTimeIso) > snapshot.now);
  let booking: WorkflowBooking | undefined;
  if (operation.kind !== 'new_booking') {
    const bookingId = operation.targetBookingId || event.targetBookingId;
    booking = bookingId ? ownedBookings.find(value => value.id === bookingId) : ownedBookings.length === 1 ? ownedBookings[0] : undefined;
    if (bookingId && !booking || ownedBookings.length === 0) return decision('failed', 'state_unavailable', 'booking_ownership_or_status_mismatch');
    if (!booking) return { ...decision('input_requested', 'target_selection', 'ambiguous_operation_target', [], 'target'),
      transition, nextOperation: next({ state: 'selecting_target' }) };
    if (operation.kind === 'reschedule' && operation.slots.service && operation.slots.service !== booking.service) {
      return decision('failed', 'state_unavailable', 'stored_edition_disagrees_with_booking');
    }
    if (event.targetBookingId && operation.targetBookingId && event.targetBookingId !== operation.targetBookingId) {
      return decision('blocked', 'blocked', 'target_change_requires_new_selection');
    }
  }
  if (event.intent === 'confirm') {
    const proposal = snapshot.proposal;
    if (!event.explicitConsent || operation.state !== 'awaiting_confirmation' || !proposal
      || proposal.id !== event.proposalId || proposal.operationId !== operation.id
      || proposal.operationRevision !== operation.revision || proposal.kind !== operation.kind
      || proposal.targetBookingId !== operation.targetBookingId || !proposal.delivered
      || proposal.presentedTurnId === event.turnId || proposal.expiresAt !== undefined && proposal.expiresAt <= snapshot.now
      || !sameSlots(proposal.slots, operation.slots)) {
      return decision('clarification_requested', 'consent_required', 'invalid_or_stale_proposal_consent', [], 'confirmation');
    }
    if (operation.kind === 'addon_change') return decision('failed', 'state_unavailable', 'addon_executor_not_implemented');
    if (operation.kind === 'new_booking' && (!Number.isInteger(proposal.amount) || proposal.amount! <= 0)) {
      return decision('failed', 'state_unavailable', 'invalid_verified_deposit');
    }
    if (operation.kind === 'new_booking' && (!operation.slots.name || !operation.slots.service || !operation.slots.date
      || !operation.slots.time || !operation.addonsDecided || operation.forSomeoneElse && !operation.slots.recipientName)) {
      return decision('failed', 'state_unavailable', 'new_booking_prerequisites_incomplete');
    }
    const proposedService = operation.slots.service;
    if (operation.kind === 'new_booking' && !snapshot.packages?.some(entry => entry.service === proposedService && entry.deposit === proposal.amount)) {
      return decision('clarification_requested', 'consent_required', 'deposit_changed_requires_new_proposal', [], 'confirmation');
    }
    if (booking) {
      const policy = getBookingPolicyWindow(new Date(booking.dateTimeIso), new Date(snapshot.now));
      const changed = operation.kind === 'reschedule' && proposal.rescheduleForfeitsDeposit !== policy.rescheduleForfeitsDeposit
        || operation.kind === 'cancellation' && proposal.cancellationRefundEligible !== policy.cancellationRefundEligible;
      if (changed) return decision('clarification_requested', 'consent_required', 'policy_changed_requires_new_proposal', [], 'confirmation');
    }
    const kind = operation.kind === 'new_booking' ? 'initiate_payment' : operation.kind === 'reschedule' ? 'apply_reschedule' : 'apply_cancellation';
    return { ...decision('confirmation_accepted', 'action_pending', 'validated_prior_turn_consent', [{
      kind, customerId: snapshot.customerId, operationId: operation.id, expectedRevision: operation.revision,
      ...(booking ? { bookingId: booking.id } : {}), proposalId: proposal.id,
      idempotencyKey: `${operation.id}:${proposal.id}:${kind}`,
    }]), transition: 'advance', nextOperation: next({ state: operation.kind === 'new_booking' ? 'payment_open' : 'applying' }) };
  }
  let slots: WorkflowSlots = { ...operation.slots, ...(booking ? { service: booking.service } : {}) };
  if (event.intent === 'accept_clarification') {
    const clarification = snapshot.clarification;
    if (!event.explicitConsent || operation.state !== 'clarifying' || !clarification
      || clarification.id !== event.clarificationId || clarification.operationId !== operation.id
      || clarification.operationRevision !== operation.revision || !clarification.delivered
      || clarification.presentedTurnId === event.turnId || !validTime(clarification.candidateTime)) {
      return decision('clarification_requested', 'confirm_time', 'invalid_time_clarification_consent', [], 'clarification');
    }
    slots = { ...slots, time: clarification.candidateTime };
  } else if (event.slots || event.rawTime) {
    if (event.slotSource !== 'customer') return decision('clarification_requested', 'clarify_intent', 'non_customer_slots_not_accepted', [], 'intent');
    if (event.slots?.date && !validDate(event.slots.date)) return decision('clarification_requested', 'missing_field', 'invalid_customer_date', [], 'date');
    if (event.slots?.time && !validTime(event.slots.time)) return decision('clarification_requested', 'missing_field', 'invalid_customer_time', [], 'time');
    if (booking && event.slots?.service && event.slots.service !== booking.service) return decision('blocked', 'blocked', 'edition_change_not_pure_reschedule');
    slots = { ...slots, ...event.slots };
    if (event.rawTime && /^1o\s*am$/i.test(event.rawTime.trim())) {
      const updated = next({ state: 'clarifying', targetBookingId: booking?.id, slots });
      const clarification: WorkflowClarification = { id: `${operation.id}:time:${updated.revision}`, operationId: operation.id,
        operationRevision: updated.revision, candidateTime: '10:00', presentedTurnId: event.turnId, delivered: false };
      return { ...decision('clarification_requested', 'confirm_time', 'time_typo_requires_customer_clarification', [{
        kind: 'request_time_clarification', customerId: snapshot.customerId, operationId: operation.id, evidenceId: clarification.id,
      }], 'clarification'), transition, nextOperation: updated, nextClarification: clarification, nextProposal: null };
    }
  }
  if (booking && operation.sameDayOnly && !slots.date) slots = { ...slots, date: booking.date };
  if (event.addonsDecision) {
    if (event.slotSource !== 'customer') return decision('clarification_requested', 'clarify_intent', 'addon_decision_requires_customer_input', [], 'addons');
    if (event.addonsDecision === 'selected') return decision('blocked', 'blocked', 'selected_addons_require_validated_storage_result');
    operation = { ...operation, addonsDecided: true };
  }
  if (operation.kind === 'addon_change') return decision('failed', 'state_unavailable', 'addon_transition_not_implemented');
  if (operation.kind === 'new_booking') {
    if (!slots.service) return { ...decision('input_requested', 'missing_field', 'missing_service', [], 'service'), transition, nextOperation: next({ state: 'collecting', slots }) };
    if (!slots.name) return { ...decision('input_requested', 'missing_field', 'missing_name', [], 'name'), transition, nextOperation: next({ state: 'collecting', slots }) };
    if (operation.forSomeoneElse && !slots.recipientName) return { ...decision('input_requested', 'missing_field', 'missing_recipient', [], 'recipient'),
      transition, nextOperation: next({ state: 'collecting', slots }) };
    if (!snapshot.packages?.some(entry => entry.service === slots.service && Number.isInteger(entry.deposit) && entry.deposit > 0)) {
      return decision('failed', 'state_unavailable', 'validated_edition_unavailable');
    }
  }
  if (operation.kind !== 'cancellation' && !slots.date) return { ...decision('input_requested', 'missing_field', 'missing_replacement_date', [], 'date'),
    transition, nextOperation: next({ state: 'collecting', slots, targetBookingId: booking?.id }) };
  if (event.intent === 'availability_result') {
    const availability = snapshot.availability;
    if (!availability || operation.state !== 'checking_availability' || availability.operationId !== operation.id
      || availability.operationRevision !== operation.revision || availability.date !== slots.date
      || availability.service !== slots.service || availability.excludeBookingId !== booking?.id) {
      return decision('failed', 'state_unavailable', 'availability_result_scope_mismatch');
    }
    if (availability.status !== 'available' || !availability.slots.length) {
      return { ...decision(availability.status === 'failed' ? 'failed' : 'availability_answered',
        availability.status === 'failed' ? 'availability_failed' : 'no_slots', 'availability_not_confirmed', [], 'date'),
        transition: 'advance', nextOperation: next({ state: 'collecting', slots }), nextProposal: null, nextClarification: null };
    }
    if (!slots.time || !availability.slots.includes(slots.time)) return { ...decision('availability_answered', 'show_slots', 'available_times_require_selection', [], 'time'),
      transition: 'advance', nextOperation: next({ state: 'collecting', slots }), availableSlots: [...availability.slots], nextProposal: null, nextClarification: null };
  } else if (operation.kind !== 'cancellation' && (event.intent === 'availability' || slots.time)) {
    const updated = next({ state: 'checking_availability', slots, targetBookingId: booking?.id });
    return { ...decision('availability_requested', 'show_slots', 'query_actual_scoped_availability', [{
      kind: 'check_availability', customerId: snapshot.customerId, operationId: operation.id, operationRevision: updated.revision,
      service: slots.service!, date: slots.date!, ...(booking ? { excludeBookingId: booking.id } : {}),
    }]), transition, nextOperation: updated, nextProposal: null, nextClarification: null };
  } else if (operation.kind !== 'cancellation' && !slots.time) return { ...decision('input_requested', 'missing_field', 'missing_replacement_time', [], 'time'),
    transition, nextOperation: next({ state: 'collecting', slots, targetBookingId: booking?.id }) };
  if (operation.kind === 'new_booking' && !operation.addonsDecided) return { ...decision('input_requested', 'missing_field', 'optional_addon_decision_required', [], 'addons'),
    transition, nextOperation: next({ state: 'collecting', slots }), nextProposal: null };
  const updated = next({ state: 'awaiting_confirmation', slots, targetBookingId: booking?.id });
  const proposal: WorkflowProposal = { id: `${operation.id}:proposal:${updated.revision}`, operationId: operation.id,
    operationRevision: updated.revision, kind: operation.kind, slots, targetBookingId: booking?.id,
    presentedTurnId: event.turnId, delivered: false,
    ...(booking ? getBookingPolicyWindow(new Date(booking.dateTimeIso), new Date(snapshot.now)) : {}),
  };
  if (operation.kind === 'new_booking') {
    const entry = snapshot.packages?.find(value => value.service === slots.service);
    if (!entry || !Number.isInteger(entry.deposit) || entry.deposit <= 0) return decision('failed', 'state_unavailable', 'validated_deposit_unavailable');
    Object.assign(proposal, { amount: entry.deposit });
  }
  return { ...decision('proposal_required', 'proposal', 'proposal_must_be_presented_before_consent', [{
    kind: 'present_proposal', customerId: snapshot.customerId, operationId: operation.id, evidenceId: proposal.id,
  }], 'confirmation'), transition, nextOperation: updated, nextProposal: proposal, nextClarification: null };
}