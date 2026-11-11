// The hub's user systemd unit is the acceptance for the reboot bug: the hub
// must run as a unit that restarts it and is installed into default.target.
// This guards the template from deletion or drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const unit = fileURLToPath(new URL('./systemd/vortex-v6-hub.service', import.meta.url))

test('hub unit template runs the hub as a restarter user service', () => {
  assert.ok(existsSync(unit), `missing ${unit}`)
  const text = readFileSync(unit, 'utf8')
  for (const section of ['[Unit]', '[Service]', '[Install]']) {
    assert.ok(text.includes(section), `missing ${section} section`)
  }
  assert.ok(text.includes('ExecStart=%h/.bun/bin/bun %h/.local/share/vortex-v6-RELEASE/v6/hub/main.ts'))
  assert.ok(text.includes('Restart=always'))
  assert.ok(text.includes('WantedBy=default.target'))
})
