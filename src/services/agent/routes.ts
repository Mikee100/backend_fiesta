import prisma from '../../config/prisma';
import { CHAT_MODEL } from './llm/provider';
import {
  circuitBreaker,
  DAILY_TOKEN_CAP,
  FALLBACK_MESSAGE,
  PROVIDER_OUTAGE_MESSAGE,
  isProviderRateLimitError,
  classifyProviderRateLimit,
  shouldNotifyOutage,
} from './resilience.service';
import { PAYMENT_PROMPT_UNRECORDED, PAYMENT_PROMPT_UNRECORDED_REPLY } from './constants';

export type RouteOutcome = {
  success?: boolean;
  isFallback?: boolean;
  failureReason?: string;
  circuitBreakerTrip?: boolean;
  circuitBreakerReason?: string;
};

export type MessageRouteResult = string | { reply: string; outcome?: RouteOutcome } | null;

export type MessageRoute = {
  name: string;
  when: () => boolean;
  handle: () => MessageRouteResult | Promise<MessageRouteResult>;
  replyMode?: 'deterministic' | 'natural';
};

export function createMessageRoutes(
  this: any,
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  platform: string,
  startedAt: number
): MessageRoute[] {
  let scopeBoundaryReply: string | null = null;
  let informationalFlowResolved = false;
  let informationalFlow: any;
  const getInformationalFlow = () => {
    if (!informationalFlowResolved) {
      informationalFlow = this.conversationFlowHandler.resolveInformationalFlow(userMessage, history);
      informationalFlowResolved = true;
    }
    return informationalFlow;
  };

  return [
    {
      name: 'scopeBoundary',
      when: () => Boolean(scopeBoundaryReply = this.getScopeBoundaryReply(userMessage, history)),
      handle: () => scopeBoundaryReply,
    },
    {
      name: 'identityCorrection',
      when: () => this.isBookingIdentityCorrection(userMessage),
      handle: async () => this.getBookingIdentityCorrectionReply(customerId, history),
    },
    {
      name: 'recipientName',
      when: () => this.shouldCaptureRecipientName(userMessage, history),
      handle: async () => {
        const recipientName = await this.captureRecipientName(customerId, userMessage);
        return recipientName
          ? `Thanks, I’ll set the session up for ${recipientName}. Which package would you like, and what date and time would work best?`
          : null;
      },
    },
    {
      name: 'ambiguousDeposit',
      replyMode: 'deterministic',
      when: () => this.shouldClarifyAmbiguousDeposit(userMessage),
      handle: () => this.getAmbiguousDepositReply(),
    },
    {
      name: 'rescheduleWithdrawalConfirmation',
      when: () => this.shouldConfirmRescheduleWithdrawal(userMessage, history),
      handle: () => 'Yes. Your original session date and time are still booked, and your deposit remains held for it.',
    },
    {
      name: 'postActionAcknowledgement',
      when: () => this.isPostActionAcknowledgement(userMessage, history),
      handle: () => this.previousMessageRequestsConfirmation(history)
        ? 'No rush. Let me know when you are ready to go ahead.'
        : 'You are welcome. I am here if you need anything else.',
    },
    {
      name: 'cancellationDeclined',
      when: () => this.hasPendingCancellationProposal(history) && this.isCancellationDecline(userMessage),
      handle: async () => {
        await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
        return 'Understood. Your booking is unchanged, and I have not cancelled it.';
      },
    },
    {
      name: 'staleCancellationProposal',
      when: () => this.hasPendingCancellationProposal(history)
        && !this.isCancellationConfirmation(userMessage)
        && !this.isCancellationDecline(userMessage)
        && !this.shouldUseCancellationRequest(userMessage, history),
      handle: async () => {
        await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
        return null;
      },
    },
    {
      name: 'cancellationProposal',
      when: () => (platform === 'whatsapp' || platform === 'web')
        && this.shouldUseCancellationRequest(userMessage, history),
      handle: async () => (await this.proposeCancellation(customerId, userMessage, history)).reply,
    },
    {
      name: 'bookingStatus',
      when: () => this.shouldUseBookingStatusReply(userMessage),
      handle: async () => this.getBookingStatusReply(customerId),
    },
    {
      name: 'upcomingAppointmentTime',
      when: () => this.shouldUseUpcomingAppointmentTimeReply(userMessage),
      handle: async () => this.getUpcomingAppointmentTimeReply(customerId),
    },
    {
      name: 'pastAppointmentsList',
      when: () => this.shouldUsePastAppointmentsListReply(userMessage),
      handle: async () => this.getPastAppointmentsListReply(customerId),
    },
    {
      name: 'lastAppointmentDetails',
      when: () => this.shouldUseLastAppointmentDetailsReply(userMessage),
      handle: async () => this.getLastAppointmentDetailsReply(customerId),
    },
    {
      name: 'upcomingAppointmentDetails',
      when: () => this.shouldUseUpcomingAppointmentDetailsReply(userMessage),
      handle: async () => this.getUpcomingAppointmentDetailsReply(customerId, history),
    },
    {
      name: 'mixedIntent',
      when: () => this.shouldClarifyMixedIntent(userMessage),
      handle: () => this.getMixedIntentClarificationReply(),
    },
    {
      name: 'invoice',
      when: () => this.shouldUseInvoiceRequestReply(userMessage, history),
      handle: async () => {
        const requestedInvoiceNumber = this.extractInvoiceNumber(userMessage);
        return this.sendStoredInvoiceToCustomer(customerId, requestedInvoiceNumber ?? undefined, history, userMessage);
      },
    },
    {
      name: 'pastAppointment',
      when: () => this.shouldUsePastAppointmentReply(userMessage) || this.isPastAppointmentFollowUp(userMessage, history),
      handle: async () => this.getPastAppointmentReply(customerId),
    },
    {
      name: 'bookingForSomeoneElse',
      when: () => this.shouldClarifyBookingForSomeoneElse(userMessage),
      handle: () => this.getBookingForSomeoneElseReply(),
    },
    {
      name: 'multiPersonBooking',
      when: () => this.shouldUseMultiPersonBookingReply(userMessage),
      handle: async () => {
        await this.captureMultiPersonBookingNote(customerId, userMessage).catch((err: unknown) => {
          console.error('Failed to capture multi-person booking note:', err);
        });
        return this.getMultiPersonBookingReply();
      },
    },
    {
      name: 'packageBudget',
      replyMode: 'deterministic',
      when: () => this.shouldUsePackageBudgetReply(userMessage),
      handle: () => this.getPackageBudgetReply(),
    },
    {
      name: 'paymentResend',
      when: () => this.shouldHandleResendRequest(userMessage),
      handle: async () => this.tryHandlePaymentResend(customerId),
    },
    {
      name: 'suspendingConceptGallery',
      when: () => {
        getInformationalFlow();
        return Boolean(this.getSuspendingConceptGalleryReply(userMessage, history));
      },
      handle: () => this.getSuspendingConceptGalleryReply(userMessage, history),
    },
    {
      name: 'reviewPage',
      when: () => Boolean(this.getReviewPageReply(userMessage)),
      handle: () => this.getReviewPageReply(userMessage),
    },
    {
      name: 'businessIntroduction',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'business_introduction',
      handle: () => this.getBusinessIntroductionReply(),
    },
    {
      name: 'weekday',
      when: () => getInformationalFlow() === 'weekday',
      handle: () => this.getWeekdayReply(userMessage, history),
    },
    {
      name: 'website',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'website',
      handle: () => this.getWebsiteReply(),
    },
    {
      name: 'contactDetails',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'contact_details',
      handle: () => this.getContactDetailsReply(),
    },
    {
      name: 'portfolio',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'portfolio',
      handle: () => this.getPortfolioReply(),
    },
    {
      name: 'socialMedia',
      replyMode: 'natural',
      when: () => this.shouldUseSocialMediaReply(userMessage),
      handle: () => this.getSocialMediaReply(),
    },
    {
      name: 'rawFiles',
      replyMode: 'deterministic',
      when: () => this.shouldUseRawFilesReply(userMessage),
      handle: () => this.getRawFilesReply(),
    },
    {
      name: 'previousAddon',
      when: () => this.shouldUsePreviousAddonReply(userMessage, history),
      handle: async () => this.getPreviousAddonReply(customerId),
    },
    {
      name: 'clarifyNewAddon',
      when: () => this.shouldClarifyNewAddon(userMessage, history),
      handle: () => 'Which add-on would you like to add to your session? I can show you the available extras if you are not sure yet.',
    },
    {
      name: 'addonListFollowUp',
      replyMode: 'deterministic',
      when: () => this.isAddonListFollowUp(userMessage, history),
      handle: () => this.getAdditionsReply(),
    },
    {
      name: 'selectedAddon',
      when: () => Boolean(this.getSelectedAddon(userMessage, history)),
      handle: async () => {
        const selectedAddon = this.getSelectedAddon(userMessage, history);
        if (!selectedAddon) return null;
        const addonQuantity = this.getRequestedAddonQuantity(userMessage, selectedAddon);
        const noteResult = await this.executeAddNoteTool(
          customerId,
          '',
          addonQuantity > 1 ? `${addonQuantity} x ${selectedAddon.name}` : selectedAddon.name,
          'special_request',
          'addon',
          'normal',
          userMessage,
          platform
        );
        return noteResult.created
          ? this.getAddonSelectionReply(selectedAddon, addonQuantity)
          : noteResult.reason === 'duplicate_pending_note'
            ? `${selectedAddon.name} is already recorded for your session, so I have not added it twice.`
            : 'I could not save that add-on just yet. Please tell me which extra you would like to include.';
      },
    },
    {
      name: 'additions',
      replyMode: 'deterministic',
      when: () => this.shouldUseAdditionsReply(userMessage),
      handle: () => this.getAdditionsReply(),
    },
    {
      name: 'bespoke',
      replyMode: 'natural',
      when: () => this.shouldUseBespokeReply(userMessage),
      handle: () => this.getBespokeReply(),
    },
    {
      name: 'travellingMothers',
      replyMode: 'natural',
      when: () => this.shouldUseTravellingMothersReply(userMessage),
      handle: () => this.getTravellingMothersReply(),
    },
    {
      name: 'earliestImageDelivery',
      replyMode: 'deterministic',
      when: () => this.shouldUseEarliestImageDeliveryReply(userMessage),
      handle: async () => this.getEarliestImageDeliveryReply(customerId),
    },
    {
      name: 'postShootProcess',
      replyMode: 'deterministic',
      when: () => this.shouldUsePostShootProcessReply(userMessage) && !this.shouldUseBookingProcessReply(userMessage),
      handle: () => this.getPostShootProcessReply(),
    },
    {
      name: 'bookingProcess',
      replyMode: 'deterministic',
      when: () => this.shouldUseBookingProcessReply(userMessage),
      handle: async () => this.getBookingProcessReply(),
    },
    {
      name: 'timeOnlyRescheduleSelection',
      when: () => this.conversationFlows.isTimeOnlyRescheduleSelection(userMessage, history),
      handle: async () => this.getRescheduleTimeProposalReply(customerId, userMessage),
    },
    {
      name: 'rescheduleWithdrawal',
      when: () => this.shouldUseRescheduleWithdrawalReply(userMessage, history),
      handle: async () => {
        await this.withdrawPendingReschedule(customerId);
        return 'Understood! We will keep your original session date and time, and your booking remains unchanged. Your deposit is still held for that session. Let us know if you need anything else preparing for your shoot!';
      },
    },
    {
      name: 'timeOnlyRescheduleRequest',
      when: () => this.conversationFlows.isTimeOnlyRescheduleRequest(userMessage),
      handle: async () => this.getRescheduleTimeReply(customerId),
    },
    {
      name: 'rescheduleRequest',
      when: () => this.shouldUseRescheduleRequestReply(userMessage),
      handle: async () => this.getRescheduleTimeReply(customerId),
    },
    {
      name: 'sameBookingSlot',
      when: () => this.conversationFlows.isSameBookingSlotRequest(userMessage),
      handle: async () => this.getSameBookingSlotReply(customerId, history),
    },
    {
      name: 'packageSelection',
      replyMode: 'deterministic',
      when: () => this.shouldResolvePackageSelectionImmediately(userMessage),
      handle: async () => this.getPackageSelectionReply(customerId, userMessage),
    },
    {
      name: 'packageAdvice',
      replyMode: 'natural',
      when: () => this.conversationFlows.isPackageAdviceRequest(userMessage),
      handle: async () => this.getPackageAdviceReply(userMessage),
    },
    {
      name: 'packageCatalog',
      replyMode: 'deterministic',
      when: () => this.conversationFlows.isPackageCatalogRequest(userMessage, history),
      handle: async () => {
        const showInclusions = this.conversationFlows.isPackageInclusionFollowUp(userMessage, history);
        return await this.getPackageCatalogReply(showInclusions, userMessage)
          || 'The studio team will share our current rate card and edition details. I cannot verify the catalog right now.';
      },
    },
    {
      name: 'immediateConfirmation',
      when: () => (platform === 'whatsapp' || platform === 'web')
        && this.isExplicitConfirmation(userMessage)
        && this.previousMessageRequestsConfirmation(history),
      handle: async () => {
        try {
          const immediate = await this.tryImmediateConfirmation(customerId, userMessage, history);
          return immediate;
        } catch (error: any) {
          console.error('[AGENT_FLOW] Immediate confirmation failed:', error);
          return {
            reply: error?.code === PAYMENT_PROMPT_UNRECORDED
              ? PAYMENT_PROMPT_UNRECORDED_REPLY
              : 'Sorry, something went wrong and I couldn’t finish that step just now. Please try again in a moment, or the studio team can help.',
            outcome: {
              success: false,
              isFallback: true,
              failureReason: String(error?.message || error).slice(0, 200),
            },
          };
        }
      },
    },
    {
      name: 'runAgent',
      when: () => true,
      handle: async () => {
        try {
          console.log('[AGENT_FLOW] No deterministic early exit matched; invoking runAgent()');
          const { content, tokensUsed, failureType } = await this.runAgent(customerId, userMessage, history, platform);
          console.log('[AGENT_FLOW] runAgent() completed successfully:', JSON.stringify({
            customerId,
            tokensUsed,
            replyPreview: content.slice(0, 200)
          }));
          circuitBreaker.recordSuccess();
          await this.recordTokenUsage(customerId, tokensUsed);
          if (failureType) {
            return { reply: content, outcome: { success: false, isFallback: true, failureReason: failureType } };
          }
          this.touchCustomerMemory(customerId, userMessage, platform).catch((err: unknown) => console.error('Customer memory update failed:', err));
          return content;
        } catch (error: any) {
          console.error('[AGENT_FLOW] Agent reply pipeline failed:', error);
          const rateLimitType = classifyProviderRateLimit(error);
          console.log('[AGENT_FLOW] Failure classification:', JSON.stringify({
            customerRef: this.customerReference(customerId),
            errorName: error?.name,
            status: error?.status,
            code: error?.code,
            rateLimitType,
          }));
          console.info('[AGENT_USAGE]', JSON.stringify({
            customerRef: this.customerReference(customerId),
            model: CHAT_MODEL,
            completionCalls: null,
            toolCalls: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            latencyMs: Date.now() - startedAt,
            rateLimited: rateLimitType !== null,
            failureType: rateLimitType || 'agent_pipeline_failure',
          }));
          const justTripped = circuitBreaker.recordFailure();
          const isOutage = isProviderRateLimitError(error);
          const pendingExtrasDecline = isOutage && (platform === 'whatsapp' || platform === 'web')
            && this.isDecliningOptionalAddons(userMessage, history);
          const fallbackReply = pendingExtrasDecline
            ? 'Noted, no optional extras. Our booking assistant is temporarily unavailable, so I have not sent a deposit proposal or M-Pesa prompt. A team member will follow up to finish your booking.'
            : isOutage
            ? PROVIDER_OUTAGE_MESSAGE
            : 'Sorry, I could not process that request right now. Please try again, or a team member will follow up with you.';
          if (rateLimitType === 'daily_tpd_exhausted' && shouldNotifyOutage()) {
            await this.escalate(customerId, 'error', `AI PROVIDER OUTAGE: Groq's daily token limit has been reached - ALL customers are currently getting the fallback message, not just this one. It resets on its own; check console.groq.com/settings/billing if this keeps recurring. Original error: ${error.message}`);
          } else if (rateLimitType === 'transient_rate_limit' && shouldNotifyOutage()) {
            await this.escalate(customerId, 'error', `AI PROVIDER RATE LIMIT: requests are being limited. No automatic retry was attempted. Original error: ${error.message}`);
          } else if (justTripped && !isOutage) {
            await this.escalate(customerId, 'error', `Circuit breaker just tripped: ${error.message}`);
          }
          if (pendingExtrasDecline) {
            await this.escalate(customerId, 'booking', 'Customer declined optional extras, but the AI provider is unavailable before the deposit proposal. Review the recent conversation, recheck slot availability, and send the booking proposal manually. No payment prompt was sent.');
          }
          return {
            reply: fallbackReply,
            outcome: {
              success: false,
              isFallback: true,
              failureReason: rateLimitType || String(error.message || error).slice(0, 200),
              circuitBreakerTrip: justTripped,
              circuitBreakerReason: justTripped ? 'Repeated failures in the reply pipeline' : undefined,
            },
          };
        }
      },
    },
  ];
}