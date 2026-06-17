const RECENT_LOCAL_PARTS = new Set<string>();

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateEmailName(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let candidate = "";
    let attempt = 0;

    while (!candidate || RECENT_LOCAL_PARTS.has(candidate)) {
        attempt += 1;
        const length = randomInt(6, 12);
        let nextValue = "";
        for (let index = 0; index < length; index += 1) {
            nextValue += chars[randomInt(0, chars.length - 1)];
        }
        candidate = nextValue;

        if (attempt > 20) {
            candidate = `${candidate}${randomInt(0, 9)}`;
        }
    }

    RECENT_LOCAL_PARTS.add(candidate);
    if (RECENT_LOCAL_PARTS.size > 20000) {
        const oldest = RECENT_LOCAL_PARTS.values().next().value;
        if (oldest) {
            RECENT_LOCAL_PARTS.delete(oldest);
        }
    }

    return candidate;
}
