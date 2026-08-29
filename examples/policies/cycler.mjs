#!/usr/bin/env node
// Cycles whatever vocabulary the game states, in order.
//
// It used to hardcode 2048's four words, which made it a 2048-only control
// wearing a general name: on ALE Breakout it emitted four illegal words, every
// one was substituted, and three replicates scored 0 with distinctInputs=1 and
// no lives lost. That reads as a player that did nothing rather than one that
// was never told the rules.
const FALLBACK = ['up', 'right', 'down', 'left']
let buffer = ''
let n = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\n')
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    let words = FALLBACK
    try {
      const request = JSON.parse(line)
      if (Array.isArray(request.commands) && request.commands.length > 0) words = request.commands
    } catch {
      // A request this policy cannot read is still a request. Answering from
      // the fallback keeps the episode gradeable instead of stalling it.
    }
    process.stdout.write(`${words[n++ % words.length]}\n`)
  }
})
