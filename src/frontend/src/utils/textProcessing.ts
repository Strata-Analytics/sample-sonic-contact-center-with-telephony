export const handleTrailingDuplicates = (text: string): string => {
  for (
    let endLength = Math.floor(text.length / 2);
    endLength > 4;
    endLength--
  ) {
    const end = text.substring(text.length - endLength);
    const beforeEnd = text.substring(0, text.length - endLength);
    if (beforeEnd.includes(end)) {
      return beforeEnd;
    }
  }
  return text;
};

export const handleCompleteDuplicates = (text: string): string => {
  const markers = [
    "[playful]",
    "[joyful]",
    "[excited]",
    "[thoughtful]",
    "[friendly]",
  ];
  for (const marker of markers) {
    if (
      text.includes(marker) &&
      text.indexOf(marker) !== text.lastIndexOf(marker)
    ) {
      return text.substring(0, text.lastIndexOf(marker));
    }
  }
  return text;
};

export const cleanMessageText = (text: string): string => {
  let cleanText = handleCompleteDuplicates(text);
  cleanText = handleTrailingDuplicates(cleanText);
  return cleanText;
};
