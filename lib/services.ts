export const SMS_SERVICE_OPTIONS = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    description: "OpenAI / ChatGPT",
    applicationId: "2754",
  },
  {
    id: "soulapp",
    label: "SoulAPP",
    description: "Soul 社交平台",
    applicationId: "3119",
  },
] as const;

export type SmsServiceKey = (typeof SMS_SERVICE_OPTIONS)[number]["id"];

export function findSmsService(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SMS_SERVICE_OPTIONS.find((service) => service.id === normalized);
}

export function defaultSmsService() {
  return SMS_SERVICE_OPTIONS[0];
}
