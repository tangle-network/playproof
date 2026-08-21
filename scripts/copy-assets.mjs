import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
// `pyshared` holds the PNG encoder every Python worker imports at start-up,
// so a dist without it is a dist whose workers cannot boot.
for (const directory of ['ale', 'desktop', 'gym', 'native', 'pyboy', 'pyshared', 'retro', 'retroarch']) {
  cpSync(directory, `dist/${directory}`, {
    recursive: true,
    filter: (source) => !source.endsWith('__pycache__') && !source.endsWith('.pyc'),
  })
}
