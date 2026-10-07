import { interpret } from '../public/js/interpreter.js'

export function estimatePromptTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

export function generateContent(program, { budget, rotations, inputs } = {}) {
  return interpret(program, { budget, rotations, inputs })
}

export function resolvePacing(config = {}, profile = null) {
  const delayCandidate = profile && profile.firstDelayMs != null ? Number(profile.firstDelayMs) : null
  const speedCandidate = profile && profile.charsPerSecond != null ? Number(profile.charsPerSecond) : null
  const overrideDelay = Number.isFinite(delayCandidate) && delayCandidate >= 0 ? delayCandidate : null
  const overrideSpeed = Number.isFinite(speedCandidate) && speedCandidate > 0 ? speedCandidate : null
  const firstDelayMs = overrideDelay != null ? overrideDelay : Number(config.firstDelayMs)
  const charsPerSecond = overrideSpeed != null ? overrideSpeed : Number(config.charsPerSecond)
  return {
    firstDelayMs: Number.isFinite(firstDelayMs) && firstDelayMs >= 0 ? firstDelayMs : 0,
    charsPerSecond: Number.isFinite(charsPerSecond) && charsPerSecond > 0 ? charsPerSecond : 30,
    chunkSize: config.chunkSize,
    maxDurationMs: config.maxDurationMs
  }
}

