import assert from 'node:assert/strict'
import { test } from 'node:test'
import { announceTopic, namespaceOfTopic, PROTOCOL_VERSION } from './topics.ts'

const NAMESPACE = 'a'.repeat(64)

// Docs: VORTEX_v5.1.md sections 2.2 and 11.5
test('the broadcast topic names the protocol version and the namespace', () => {
  assert.equal(announceTopic(NAMESPACE), `/vortex/${PROTOCOL_VERSION}/announce/${NAMESPACE}`)
  assert.equal(PROTOCOL_VERSION, 1)
})

// Docs: VORTEX_v5.1.md sections 2.2 and 2.4
test('announceTopic accepts only 64 lowercase hexadecimal characters', () => {
  assert.throws(() => announceTopic(''), /namespace must be 64 lowercase hexadecimal characters/)
  assert.throws(() => announceTopic('a'.repeat(63)), /namespace must be 64 lowercase hexadecimal characters/)
  assert.throws(() => announceTopic('a'.repeat(65)), /namespace must be 64 lowercase hexadecimal characters/)
  assert.throws(() => announceTopic('A'.repeat(64)), /namespace must be 64 lowercase hexadecimal characters/)
  assert.throws(() => announceTopic('g'.repeat(64)), /namespace must be 64 lowercase hexadecimal characters/)
  assert.equal(announceTopic('0'.repeat(64)), `/vortex/${PROTOCOL_VERSION}/announce/${'0'.repeat(64)}`)
})

// Docs: VORTEX_v5.1.md sections 2.2 and 11.5
test('a topic built by announceTopic belongs to its namespace', () => {
  assert.equal(namespaceOfTopic(announceTopic(NAMESPACE)), NAMESPACE)
})

// Docs: VORTEX_v5.1.md sections 2.2 and 11.5
test('anything else is not an announcement topic of this protocol version', () => {
  assert.equal(namespaceOfTopic(`/vortex/${PROTOCOL_VERSION + 1}/announce/${NAMESPACE}`), undefined)
  assert.equal(namespaceOfTopic(`/vortex/${PROTOCOL_VERSION}/conference/${NAMESPACE}`), undefined)
  assert.equal(namespaceOfTopic(`/vortex/${PROTOCOL_VERSION}/announce/${'A'.repeat(64)}`), undefined)
  assert.equal(namespaceOfTopic(`/vortex/${PROTOCOL_VERSION}/announce/${'a'.repeat(63)}`), undefined)
  assert.equal(namespaceOfTopic(`/vortex/${PROTOCOL_VERSION}/announce/${'a'.repeat(65)}`), undefined)
  assert.equal(namespaceOfTopic(`${announceTopic(NAMESPACE)}/more`), undefined)
  assert.equal(namespaceOfTopic(`${announceTopic(NAMESPACE)} `), undefined)
  assert.equal(namespaceOfTopic(''), undefined)
})
