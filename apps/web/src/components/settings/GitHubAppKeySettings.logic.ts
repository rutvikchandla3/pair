const FLATTENED_PEM = /^(-----BEGIN [A-Z ]+-----)\s*([\s\S]*?)\s*(-----END [A-Z ]+-----)$/u;

/** A password field drops a pasted PEM's line breaks; the key only parses with its armor lines back. */
export function restorePemLineBreaks(pasted: string): string {
  const trimmed = pasted.trim();
  const match = FLATTENED_PEM.exec(trimmed);
  return match ? `${match[1]}\n${match[2]}\n${match[3]}` : trimmed;
}
