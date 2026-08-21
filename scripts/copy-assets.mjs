import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
for (const directory of ['ale', 'desktop', 'gym', 'native', 'pyboy', 'retro']) {
  cpSync(directory, `dist/${directory}`, {
    recursive: true,
    filter: (source) => !source.endsWith('__pycache__') && !source.endsWith('.pyc'),
  })
}
