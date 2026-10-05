/** Matchers are written with straight quotes; phones and models often send curly ones (I’ve, “yes”). */
export function normalizeQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"');
}

// Word-anchored so "exchange" or "remove" no longer read as a reschedule.
export const RESCHEDULE_KEYWORD_PATTERN = /\b(?:reschedul(?:e|ed|es|ing)|chang(?:e|ed|es|ing)|mov(?:e|ed|es|ing)|postpon(?:e|ed|es|ing))\b|\bpush(?:ed|es|ing)?\s+(?:it|this|that|(?:my|the)\s+(?:session|booking|appointment|shoot))\s+(?:back|forward|to|till|until|for)\b/;