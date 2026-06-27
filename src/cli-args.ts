function readNpmConfigValue(flag: string): string {
    const key = `npm_config_${flag.replace(/^--/, "").replace(/-/g, "_")}`;
    return String(process.env[key] ?? "").trim();
}

export function readArgValue(flag: string): string {
    const inlinePrefix = `${flag}=`;
    const inlineArg = process.argv.find((arg) => arg.startsWith(inlinePrefix));
    if (inlineArg) {
        return inlineArg.slice(inlinePrefix.length);
    }

    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return readNpmConfigValue(flag);
    }
    return process.argv[index + 1] ?? "";
}

export function hasFlag(flag: string): boolean {
    return process.argv.includes(flag) || readNpmConfigValue(flag) === "true";
}

export function readPositiveIntArg(flag: string): number | null {
    const raw = readArgValue(flag).trim();
    if (!raw) {
        return null;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}
