/**
 * Settings live in one JSON file next to the OpenCode config, so the choice
 * survives restarts, is shared by every project and can be edited by hand.
 *
 * Server part only (uses `node:fs`).
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { DEFAULT_SETTINGS, normalizeSettings, type FallbackSettings } from "./shared"

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(base, "opencode", "auto-fallback.json")
}

export interface LoadedSettings {
  readonly settings: FallbackSettings
  /** `undefined` when the file does not exist yet. */
  readonly mtimeMs: number | undefined
}

/** Missing or broken file: defaults, never an exception. */
export async function readSettings(file: string): Promise<LoadedSettings> {
  try {
    const info = await stat(file)
    const text = await readFile(file, "utf8")
    return { settings: normalizeSettings(JSON.parse(text)), mtimeMs: info.mtimeMs }
  } catch {
    return { settings: DEFAULT_SETTINGS, mtimeMs: undefined }
  }
}

/** Write through a temp file so a crash never leaves half a JSON document. */
export async function writeSettings(file: string, settings: FallbackSettings): Promise<number | undefined> {
  const body = {
    enabled: settings.enabled,
    chain: settings.chain,
    cooldownMinutes: settings.cooldownMinutes,
    maxRetryDelayMs: settings.maxRetryDelayMs,
  }
  const text = `${JSON.stringify(body, null, 2)}\n`
  const temporary = `${file}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, text, "utf8")
    await rename(temporary, file)
    const info = await stat(file)
    return info.mtimeMs
  } catch {
    return undefined
  }
}
