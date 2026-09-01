import { ConversationFlowMatcher, type ConversationMessage } from './conversation-flow.matcher';

export type InformationalFlow =
  | 'business_introduction'
  | 'weekday'
  | 'website'
  | 'contact_details'
  | 'portfolio'
  | null;

export class ConversationFlowHandler {
  constructor(private readonly matcher: ConversationFlowMatcher) {}

  resolveInformationalFlow(message: string, _history: ConversationMessage[]): InformationalFlow {
    if (this.matcher.isBusinessIntroductionRequest(message)) return 'business_introduction';
    if (this.matcher.isWeekdayRequest(message)) return 'weekday';
    if (this.matcher.isWebsiteRequest(message)) return 'website';
    if (this.matcher.isContactDetailsRequest(message)) return 'contact_details';
    if (this.matcher.isPortfolioRequest(message)) return 'portfolio';
    return null;
  }
}
