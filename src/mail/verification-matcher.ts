export interface VerificationMailCandidate {
    id?: string;
    sender?: string;
    recipient?: string | string[];
    subject?: string;
    content?: string;
    timestamp?: number;
    extraTexts?: string[];
}

interface FindVerificationMailOptions<T> {
    targetEmail?: string;
    candidateMatcher?: (mail: T) => boolean;
    rememberLastCode?: boolean;
}

const lastVerificationCodeByEmail = new Map<string, string>();

export function normalizeMailbox(value: string): string {
    const input = String(value ?? "").trim().toLowerCase();
    const angleMatch = input.match(/<([^>]+)>/);
    return (angleMatch?.[1] ?? input).trim();
}

function extractVerificationCode(text: string): string {
    const raw = String(text ?? "");
    if (!raw) {
        return "";
    }

    const directMatch = raw.match(/\b(\d{6})\b/);
    if (directMatch?.[1]) {
        return directMatch[1];
    }

    const compactMatch = raw
        .replace(/<[^>]+>/g, " ")
        .match(/(?:^|[^\d])((?:\d[\s-]*){6})(?:[^\d]|$)/);
    if (!compactMatch?.[1]) {
        return "";
    }

    const digitsOnly = compactMatch[1].replace(/\D/g, "");
    return digitsOnly.length === 6 ? digitsOnly : "";
}

function normalizeRecipientList(recipient: string | string[] | undefined): string[] {
    if (Array.isArray(recipient)) {
        return recipient
            .map((item) => normalizeMailbox(item))
            .filter(Boolean);
    }
    const normalized = normalizeMailbox(recipient ?? "");
    return normalized ? [normalized] : [];
}

function collectCandidateTexts(mail: VerificationMailCandidate): string[] {
    const texts = [mail.subject ?? "", mail.content ?? "", ...(mail.extraTexts ?? [])];
    return texts
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
}

export function findLatestVerificationMail<T extends VerificationMailCandidate>(
    mails: T[],
    options: FindVerificationMailOptions<T> = {},
): (T & { verificationCode: string }) | null {
    const targetEmail = normalizeMailbox(options.targetEmail ?? "");
    const previousCode = targetEmail ? lastVerificationCodeByEmail.get(targetEmail) ?? "" : "";
    const sorted = [...mails].sort(
        (left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0),
    );

    for (const mail of sorted) {
        if (targetEmail) {
            const recipients = normalizeRecipientList(mail.recipient);
            if (recipients.length > 0 && !recipients.includes(targetEmail)) {
                continue;
            }
        }

        if (options.candidateMatcher && !options.candidateMatcher(mail)) {
            continue;
        }

        const verificationCode = collectCandidateTexts(mail)
            .map((text) => extractVerificationCode(text))
            .find(Boolean) ?? "";

        if (!verificationCode) {
            continue;
        }

        if (previousCode && verificationCode === previousCode) {
            continue;
        }

        const matchedMail = {
            ...mail,
            verificationCode,
        };
        if (targetEmail && options.rememberLastCode !== false) {
            lastVerificationCodeByEmail.set(targetEmail, verificationCode);
        }
        return matchedMail;
    }

    return null;
}
