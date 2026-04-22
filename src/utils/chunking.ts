export function chunkText(text: string, maxTokens: number = 250): string[] {
  // A rudimentary chunker splitting by sentences or paragraphs
  // In a robust system, we would use exactly a Tokenizer (like tiktoken)
  // Here we split by periods and group them.
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk.length + sentence.length) > (maxTokens * 4)) {
      // rough heuristic: 1 token = ~4 characters
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += ' ' + sentence;
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}
