import type OpenAI from 'openai';
import { createChatCompletion, primaryProvider, type ChatProvider } from './provider';
import { isProviderRateLimitError } from '../resilience.service';

export function normalizeToolName(rawName: string): string {
  return String(rawName || '').split('<|')[0].trim();
}

export function isToolNameValidationError(error: any): boolean {
  const message = String(error?.error?.message || error?.message || '');
  return (
    error?.status === 400 &&
    error?.code === 'tool_use_failed' &&
    message.includes('attempted to call tool')
  );
}

/** Provider rejects the turn when the model emits a tool call while no tools were exposed. */
export function isToolCallWithoutToolsError(error: any): boolean {
  const message = String(error?.error?.message || error?.message || '').toLowerCase();
  return (
    error?.status === 400 &&
    error?.code === 'tool_use_failed' &&
    message.includes('tool choice is none')
  );
}

export async function createCompletionWithToolNameGuard(
  params: any,
  allowedToolNames: string[],
  fallbackTools?: OpenAI.Chat.Completions.ChatCompletionTool[],
  preferredProvider?: ChatProvider
): Promise<{ response: any; completionCalls: number; provider: ChatProvider }> {
  let provider: ChatProvider = preferredProvider ?? primaryProvider();
  let completionCalls = 0;
  const request = async (requestParams: any) => {
    const result = await createChatCompletion(requestParams, provider);
    provider = result.provider;
    completionCalls += result.completionCalls;
    return result.response;
  };
  try {
    return { response: await request(params), completionCalls, provider };
  } catch (error: any) {
    if (isToolCallWithoutToolsError(error)) {
      console.warn('Retrying completion after tool call was emitted with no tools exposed.');
      if (fallbackTools && fallbackTools.length > 0) {
        try {
          const response = await request({
            ...params,
            tools: fallbackTools,
            tool_choice: 'auto',
          });
          return { response, completionCalls, provider };
        } catch (toolRetryError: any) {
          if (isProviderRateLimitError(toolRetryError)) throw toolRetryError;
          console.warn('Retry with fallback tools failed:', toolRetryError?.message);
        }
      }

      try {
        const { tools: _tools, tool_choice: _toolChoice, ...toollessParams } = params;
        const response = await request({
          ...toollessParams,
          messages: [
            ...params.messages,
            {
              role: 'system',
              content: 'CRITICAL: No tools are available this turn. Do NOT emit a tool or function call. Reply to the customer in plain text only, and ask for any missing booking details instead of looking them up.'
            }
          ],
          temperature: 0,
        });
        return { response, completionCalls, provider };
      } catch (textRetryError: any) {
        if (isProviderRateLimitError(textRetryError)) throw textRetryError;
        console.error('Toolless retry failed after model emitted tool call:', textRetryError?.message);
        throw error;
      }
    }

    if (!isToolNameValidationError(error)) throw error;

    let attemptedRawName: string | undefined;
    try {
      const failedGeneration = error?.error?.failed_generation;
      if (failedGeneration) {
        const parsed = JSON.parse(failedGeneration);
        attemptedRawName = parsed?.name;
      }
    } catch {
      // Best-effort parse only; keep retrying even if parsing fails.
    }

    const attemptedNormalized = normalizeToolName(attemptedRawName || '');
    console.warn('Retrying completion after malformed tool name:', {
      attemptedRawName,
      attemptedNormalized,
    });

    const retryMessages = [
      ...params.messages,
      {
        role: 'system',
        content: `CRITICAL TOOL RULE: If you call a tool, the function name must be EXACTLY one of: ${allowedToolNames.join(', ')}. Do not add any extra suffixes, prefixes, tags, or channel markers.`
      }
    ];

    const response = await request({
      ...params,
      messages: retryMessages,
      temperature: 0,
    });
    return { response, completionCalls, provider };
  }
}
