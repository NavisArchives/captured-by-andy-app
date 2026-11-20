import test from 'node:test';
import assert from 'node:assert/strict';
import { speechSegments, subtitleCues, subtitles } from '../src/lib/subtitles.ts';
test('caption parsing rejects malformed timings and sorts without trusting JSON', () => {
  assert.deepEqual(speechSegments('bad'), []);
  assert.deepEqual(speechSegments('{}'), []);
  const segments = speechSegments(JSON.stringify([{ start: 2, end: 3, text: 'world' }, { start: 1, end: 1.5, text: 'Hello\nthere' }, { start: -1, end: 2, text: 'bad' }]));
  assert.deepEqual(segments.map(s => s.text), ['Hello there', 'world']);
  assert.equal(subtitleCues(segments)[0].text, 'Hello there world');
  assert.equal(segments[0].text, 'Hello there', 'grouping does not mutate stored speech');
});
test('SRT and VTT preserve hours and milliseconds and split long gaps', () => {
  const segments = [{ start: 0.125, end: 1.25, text: 'Hello' }, { start: 3601.005, end: 3602, text: 'Later' }];
  assert.equal(subtitles(segments, 'srt'), '1\n00:00:00,125 --> 00:00:01,250\nHello\n\n2\n01:00:01,005 --> 01:00:02,000\nLater\n');
  assert.ok(subtitles(segments, 'vtt').startsWith('WEBVTT\n\n1\n00:00:00.125'));
});
