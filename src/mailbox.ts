import {appConfig, type MailProviderName} from "./config.js";
import {create2925Provider} from "./mail/2925.js";
import {createCloudflareProvider} from "./mail/cloudflare.js";
import {createGmailProvider} from "./mail/gmail.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {createProxiedMailProvider} from "./mail/proxiedmail.js";

export interface EmailCodeProvider {
  getEmailAddress(): Promise<string>;
  getEmailVerificationCode(email: string): Promise<string>;
}

export const MAILBOX_CONFIG: {
  provider: MailProviderName;
} = {
  provider: appConfig.provider,
};

function createProvider(): EmailCodeProvider {
  switch (MAILBOX_CONFIG.provider) {
    case "proxiedmail":
      return createProxiedMailProvider();
    case "gmail":
      return createGmailProvider();
    case "hotmail":
      return createHotmailProvider();
    case "2925":
      return create2925Provider();
    case "cloudflare":
      return createCloudflareProvider();
    default:
      throw new Error(`不支持的邮箱 provider: ${MAILBOX_CONFIG.provider}`);
  }
}

const provider = createProvider();

export async function getEmailAddress(): Promise<string> {
  return provider.getEmailAddress();
}

export async function getEmailVerificationCode(email: string): Promise<string> {
  return provider.getEmailVerificationCode(email);
}
