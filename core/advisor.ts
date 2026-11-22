export const ADVISOR_CHAT_PREFIX = "advisor-";

export const advisorChatId = (chatId: string): string => `${ADVISOR_CHAT_PREFIX}${chatId}`;

export const isAdvisorChat = (chatId: string): boolean => chatId.startsWith(ADVISOR_CHAT_PREFIX);
