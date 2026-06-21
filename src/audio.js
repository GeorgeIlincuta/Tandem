// Records mono 16-bit PCM WAV from the default mic via Web Audio, and plays WAV.
let audioContext = null;
let mediaStream = null;
let processor = null;
let sourceNode = null;
let chunks = [];
let recordingSampleRate = 44100;
const player = new Audio();

export async function startRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new AudioContext();
  recordingSampleRate = audioContext.sampleRate;
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  chunks = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  sourceNode.connect(processor);
  processor.connect(audioContext.destination);
}

export async function stopRecording() {
  if (processor) processor.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioContext) await audioContext.close();

  const samples = flatten(chunks);
  const wav = encodeWav(samples, recordingSampleRate);
  chunks = [];
  processor = sourceNode = mediaStream = audioContext = null;
  return new Blob([wav], { type: "audio/wav" });
}

export function playWav(bytes) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: "audio/wav" });
  player.src = URL.createObjectURL(blob);
  return player.play();
}

function flatten(buffers) {
  let length = 0;
  for (const b of buffers) length += b.length;
  const result = new Float32Array(length);
  let offset = 0;
  for (const b of buffers) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s * 32767, true);
    off += 2;
  }
  return buffer;
}
