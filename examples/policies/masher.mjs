#!/usr/bin/env node
// A trivial baseline: one word, always. It is what a real arm has to beat.
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\n')
    if (at < 0) break
    buffer = buffer.slice(at + 1)
    process.stdout.write('up\n')
  }
})
