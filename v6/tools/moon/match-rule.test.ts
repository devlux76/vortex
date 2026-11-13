// #16: the matching rule from the H3 calibration — floor 0.82 at 768
// dimensions, rank, plain-text confirmation decides among survivors.
import { test } from 'bun:test'
import { expect } from 'bun:test'
import { selectChannel, MATCH_FLOOR } from './match-rule.ts'

const target = { name: 'moon-webrtc', score: 0.939, topic: 'A browser peer uses WebRTC or a libp2p relay to exchange signed messages' }
// A HARD same-domain decoy (webrtc-audio-echo from the calibration family):
// close in cosine, which is exactly why the margin rule of #10 was replaced.
const hardDecoy = { name: 'moon-rtc-echo', score: 0.88, topic: 'Users hear their own voice echoed back during WebRTC calls' }
const easyDecoy = { name: 'moon-gardening', score: 0.73, topic: 'Growing garden vegetables in soil' }

test('floor cuts the easy decoy, keeps the hard one, ranks by score', () => {
  const s = selectChannel([target, hardDecoy, easyDecoy], ['moon-webrtc', 'moon-rtc-echo', 'moon-gardening'])
  expect(s.floor).toBe(MATCH_FLOOR)
  expect(s.floor).toBe(0.82)
  expect(s.ranked.map(candidate => candidate.name)).toEqual(['moon-webrtc', 'moon-rtc-echo'])
  expect(s.channel).toBe('moon-webrtc')
  expect(s.confirmedPick).toBeUndefined()
})

test('the plain-text confirmation decides among survivors — the decoy behavior is explicit', () => {
  // The model may confirm the decoy: the rule follows the confirmation and
  // the transcript shows which candidate was confirmed.
  const decoyed = selectChannel([target, hardDecoy], ['moon-webrtc', 'moon-rtc-echo'], 2)
  expect(decoyed.channel).toBe('moon-rtc-echo')
  expect(decoyed.confirmedPick).toBe(2)
  const kept = selectChannel([target, hardDecoy], ['moon-webrtc', 'moon-rtc-echo'], 1)
  expect(kept.channel).toBe('moon-webrtc')
})

test('a confirmation naming a candidate below the floor cannot select it', () => {
  // The easy decoy was cut by the floor; a stray "3" falls back to rank 1.
  const s = selectChannel([target, hardDecoy, easyDecoy], ['moon-webrtc', 'moon-rtc-echo', 'moon-gardening'], 3)
  expect(s.ranked.some(candidate => candidate.name === 'moon-gardening')).toBe(false)
  expect(s.channel).toBe('moon-webrtc')
})

test('nothing above the floor is a hard error, not a guess', () => {
  expect(() => selectChannel([easyDecoy], ['moon-gardening'])).toThrow(/floor/)
})

test('namespaces not discovered are ignored even if they score high', () => {
  const s = selectChannel([target, hardDecoy], ['moon-webrtc'])
  expect(s.ranked.map(candidate => candidate.name)).toEqual(['moon-webrtc'])
  expect(s.channel).toBe('moon-webrtc')
})
