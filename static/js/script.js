const flowerButton = document.querySelector("#flowerButton");
const voiceStatus = document.querySelector("#voiceStatus");
const API_BASE_URL = "https://birthday-website-1-dhd2.onrender.com";
const RECORDING_LIMIT_MS = 120000;
const MAX_UPLOAD_PART_BYTES = 12 * 1024;
let voiceSessionGeneration = 0;
let recordingDatabasePromise;
const activeRecordingUploads = new Map();

function logVoice(level, message, details) {
  const logger = console[level] || console.info;
  logger.call(console, `[voice ${new Date().toISOString()}] ${message}`, details || "");
}

function createRecordingSessionId() {
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function addFloatingElements(container, kind, count) {
  if (!container) return;
  const symbols = kind === "petal" ? ["✿", "❀", "·", "✧"] : ["✦", "·", "✧"];
  for (let index = 0; index < count; index += 1) {
    const element = document.createElement("span");
    element.className = kind;
    element.textContent = symbols[index % symbols.length];
    element.style.setProperty("--x", `${(index * 37 + 9) % 100}%`);
    element.style.setProperty("--delay", `${-((index * 1.71) % 19)}s`);
    element.style.setProperty("--duration", `${13 + ((index * 7) % 13)}s`);
    element.style.setProperty("--drift", `${((index * 31) % 90) - 45}px`);
    container.append(element);
  }
}

addFloatingElements(document.querySelector("#gardenFlutter"), "garden-particle", 30);
addFloatingElements(document.querySelector("#memoryPetals"), "memory-petal", 25);
addFloatingElements(document.querySelector("#fireflies"), "firefly", 20);

function normalizeSpokenWord(transcript) {
  return transcript.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function chooseRecorderType() {
  if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== "function") return "";
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
    .find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
}

function recordingExtension(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}

function openRecordingDatabase() {
  if (recordingDatabasePromise) return recordingDatabasePromise;
  recordingDatabasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open("garden-recordings", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("parts")) {
        database.createObjectStore("parts", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("sessions")) {
        database.createObjectStore("sessions", { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local recording storage."));
    request.onblocked = () => reject(new Error("Local recording storage is blocked by another open page."));
  });
  return recordingDatabasePromise;
}

function transactionFinished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Local recording storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Local recording storage transaction was aborted."));
  });
}

async function persistRecordingParts(sessionId, chunkIndex, partCount, extension, parts) {
  const database = await openRecordingDatabase();
  const transaction = database.transaction("parts", "readwrite");
  const finished = transactionFinished(transaction);
  const store = transaction.objectStore("parts");
  parts.forEach((blob, partIndex) => {
    store.put({
      key: `${sessionId}:${chunkIndex}:${partIndex}`,
      sessionId,
      chunkIndex,
      partIndex,
      partCount,
      extension,
      blob
    });
  });
  await finished;
}

async function persistRecordingFinalization(sessionId, finalChunk, extension) {
  const database = await openRecordingDatabase();
  const transaction = database.transaction("sessions", "readwrite");
  const finished = transactionFinished(transaction);
  transaction.objectStore("sessions").put({ sessionId, finalChunk, extension });
  await finished;
}

async function readPendingRecordingUploads() {
  const database = await openRecordingDatabase();
  const transaction = database.transaction(["parts", "sessions"], "readonly");
  const finished = transactionFinished(transaction);
  const partsRequest = transaction.objectStore("parts").getAll();
  const sessionsRequest = transaction.objectStore("sessions").getAll();
  const [parts, sessions] = await Promise.all([
    new Promise((resolve, reject) => {
      partsRequest.onsuccess = () => resolve(partsRequest.result);
      partsRequest.onerror = () => reject(partsRequest.error);
    }),
    new Promise((resolve, reject) => {
      sessionsRequest.onsuccess = () => resolve(sessionsRequest.result);
      sessionsRequest.onerror = () => reject(sessionsRequest.error);
    })
  ]);
  await finished;
  return { parts, sessions };
}

async function removeUploadedRecordingPart(key) {
  const database = await openRecordingDatabase();
  const transaction = database.transaction("parts", "readwrite");
  const finished = transactionFinished(transaction);
  transaction.objectStore("parts").delete(key);
  await finished;
}

async function removeFinishedRecording(sessionId) {
  const database = await openRecordingDatabase();
  const transaction = database.transaction(["parts", "sessions"], "readwrite");
  const finished = transactionFinished(transaction);
  const partsStore = transaction.objectStore("parts");
  const keysRequest = partsStore.getAllKeys();
  keysRequest.onsuccess = () => {
    keysRequest.result
      .filter((key) => key.startsWith(`${sessionId}:`))
      .forEach((key) => partsStore.delete(key));
  };
  transaction.objectStore("sessions").delete(sessionId);
  await finished;
}

async function requestRecordingUpload(url, options, description) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const requestTimeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      logVoice("info", `${description} request.`, { url, attempt: attempt + 1 });
      const response = await fetch(url, { ...options, signal: controller.signal });
      let result;
      try {
        result = await response.json();
      } catch (error) {
        throw new Error(`HTTP ${response.status} returned an invalid JSON response: ${error.message}`);
      }
      logVoice(response.ok ? "info" : "error", `${description} response.`, {
        status: response.status,
        body: result
      });
      if (!response.ok || !result.success) {
        const error = new Error(result.error || `HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return { response, result };
    } catch (error) {
      lastError = error;
      logVoice("warn", `${description} attempt failed.`, { attempt: attempt + 1, error });
      if (error.retryable === false) break;
      if (attempt < 4) {
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(250 * (2 ** attempt), 4000)));
      }
    } finally {
      window.clearTimeout(requestTimeout);
    }
  }
  throw lastError || new Error(`${description} failed.`);
}

function processRecordingUpload(sessionId) {
  if (activeRecordingUploads.has(sessionId)) return activeRecordingUploads.get(sessionId);
  const upload = (async () => {
    const pending = await readPendingRecordingUploads();
    const session = pending.sessions.find((item) => item.sessionId === sessionId);
    if (!session) return;
    const parts = pending.parts
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => left.chunkIndex - right.chunkIndex || left.partIndex - right.partIndex);

    for (const part of parts) {
      const query = new URLSearchParams({
        extension: part.extension,
        parts: String(part.partCount)
      });
      const url = `${API_BASE_URL}/api/recordings/${sessionId}/chunks/${part.chunkIndex}/${part.partIndex}?${query}`;
      const { result } = await requestRecordingUpload(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: part.blob
      }, "Audio chunk upload");
      await removeUploadedRecordingPart(part.key);
      if (result.complete === true && result.filename && Number(result.size) > 0) {
        logVoice("info", "Backend confirmed a non-empty recording file.", {
          sessionId, filename: result.filename, bytes: result.size
        });
        await removeFinishedRecording(sessionId);
        return;
      }
    }

    const url = `${API_BASE_URL}/api/recordings/${sessionId}/complete`;
    const body = JSON.stringify({ final_chunk: session.finalChunk, extension: session.extension });
    let result;
    let completionConfirmed = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const completion = await requestRecordingUpload(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }, "Recording completion");
      result = completion.result;
      if (
        result.complete === true
        && result.filename
        && Number.isInteger(Number(result.size))
        && Number(result.size) > 0
      ) {
        completionConfirmed = true;
        break;
      }
      if (completion.response.status !== 202) {
        const error = new Error(`Backend did not confirm a non-empty recording file (HTTP ${completion.response.status}).`);
        error.retryable = false;
        throw error;
      }
      logVoice("warn", "Backend accepted completion but still reports missing audio parts.", {
        sessionId, attempt: attempt + 1, body: result
      });
      if (attempt < 4) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    }
    if (!completionConfirmed) {
      const error = new Error("Backend did not confirm the completed recording after five checks.");
      error.retryable = true;
      throw error;
    }
    logVoice("info", "Backend confirmed a non-empty recording file.", {
      sessionId, filename: result.filename, bytes: result.size
    });
    await removeFinishedRecording(sessionId);
  })().catch((error) => {
    logVoice("error", "Recording upload remains queued for a later retry.", { sessionId, error });
    if (error.retryable !== false) {
      window.setTimeout(() => {
        void processRecordingUpload(sessionId);
      }, 5000);
    }
  }).finally(() => {
    activeRecordingUploads.delete(sessionId);
  });
  activeRecordingUploads.set(sessionId, upload);
  return upload;
}

async function resumePendingRecordingUploads() {
  if (!window.indexedDB) return;
  try {
    const pending = await readPendingRecordingUploads();
    pending.sessions.forEach((session) => {
      void processRecordingUpload(session.sessionId);
    });
  } catch (error) {
    logVoice("error", "Could not resume locally queued recording uploads.", error);
  }
}

async function beginGardenUnlock() {
  if (!flowerButton || flowerButton.disabled) return;
  const sessionGeneration = ++voiceSessionGeneration;
  logVoice("info", "Flower button clicked; creating voice session.", { sessionGeneration });
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (window.isSecureContext === false) {
    logVoice("error", "Voice unlock requires a secure HTTPS page.");
    if (voiceStatus) voiceStatus.textContent = "Microphone access requires HTTPS. Open the secure site and try again.";
    return;
  }
  if (!Recognition) {
    logVoice("error", "This browser does not support Web Speech Recognition.");
    if (voiceStatus) voiceStatus.textContent = "Voice recognition is not supported here. Try Chrome on Android or a supported desktop browser.";
    return;
  }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    logVoice("error", "Voice recording is unavailable in this browser or secure context.");
    if (voiceStatus) voiceStatus.textContent = "Microphone recording is unavailable. Use a current browser over HTTPS.";
    return;
  }

  flowerButton.disabled = true;
  flowerButton.classList.add("is-listening");
  let stream;
  let recorder;
  let currentRecognition;
  let recognitionRunning = false;
  let recognitionRestartTimer;
  let recognitionRecoveryTimer;
  let timeoutTimer;
  let recordingStopped = false;
  let sessionFinished = false;
  let helloDetected = false;
  let nextChunkIndex = 0;
  let capturedChunkCount = 0;
  let capturedAudioBytes = 0;
  const pendingChunkWrites = [];
  let recordingStartedAt = 0;
  let recordingFinalizationStarted = false;
  let navigationStarted = false;
  const sessionId = createRecordingSessionId();
  const mimeType = chooseRecorderType();
  let extension = recordingExtension(mimeType || "audio/webm");
  logVoice("info", "Voice session created.", { sessionGeneration, sessionId });

  function isCurrentSession() {
    return sessionGeneration === voiceSessionGeneration;
  }

  function setStatus(message) {
    if (voiceStatus) voiceStatus.textContent = message;
  }

  function stopRecognition() {
    window.clearTimeout(recognitionRestartTimer);
    window.clearTimeout(recognitionRecoveryTimer);
    recognitionRunning = false;
    if (!currentRecognition) return;
    try {
      currentRecognition.stop();
    } catch (error) {
      logVoice("warn", "Speech recognition was already stopped.", error);
    }
  }

  function scheduleRecognitionRestart(delay = 250) {
    if (!isCurrentSession() || sessionFinished || recognitionRestartTimer) return;
    recognitionRestartTimer = window.setTimeout(() => {
      recognitionRestartTimer = null;
      if (isCurrentSession()) startRecognition(true);
    }, delay);
  }

  function handleHello() {
    if (!isCurrentSession() || sessionFinished) return;
    logVoice("info", "Hello detected.");
    helloDetected = true;
    sessionFinished = true;
    window.clearTimeout(timeoutTimer);
    window.clearTimeout(recognitionRestartTimer);
    window.clearTimeout(recognitionRecoveryTimer);
    stopRecognition();
    setStatus("Hello heard — opening your surprise. The recording will upload in the background.");
    document.body.classList.add("garden-blooming");
    stopRecording();
  }

  function navigateToBirthday() {
    if (!isCurrentSession() || navigationStarted) return;
    navigationStarted = true;
    logVoice("info", "Navigation initiated.", { destination: "birthday.html", sessionId });
    window.location.assign("birthday.html");
  }

  function startRecognition(isRestart = false) {
    if (!isCurrentSession() || sessionFinished || recognitionRunning) return;
    let recognition;
    try {
      recognition = new Recognition();
    } catch (error) {
      logVoice("error", "Speech recognition could not be created.", error);
      scheduleRecognitionRestart(1000);
      return;
    }
    currentRecognition = recognition;
    recognitionRunning = true;
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 5;

    recognition.addEventListener("start", () => {
      if (!isCurrentSession() || currentRecognition !== recognition || sessionFinished) return;
      recognitionRunning = true;
      logVoice("info", isRestart ? "Speech recognition restarted." : "Speech recognition started.", { sessionId });
    });
    ["audiostart", "audioend", "soundstart", "soundend", "speechstart", "speechend", "nomatch"].forEach((eventName) => {
      recognition.addEventListener(eventName, (event) => {
        if (!isCurrentSession() || currentRecognition !== recognition) return;
        logVoice("info", `Speech recognition ${eventName} event.`, { sessionId, event });
      });
    });
    recognition.addEventListener("result", (event) => {
      if (!isCurrentSession() || currentRecognition !== recognition || sessionFinished) return;
      const alternatives = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        for (let alternativeIndex = 0; alternativeIndex < result.length; alternativeIndex += 1) {
          const alternative = result[alternativeIndex];
          const spokenText = alternative.transcript || "";
          logVoice("info", "Speech transcript.", { sessionId, transcript: spokenText });
          alternatives.push(normalizeSpokenWord(spokenText));
        }
      }
      if (alternatives.some((text) => text.split(" ").includes("hello"))) handleHello();
    });
    recognition.addEventListener("error", (event) => {
      if (!isCurrentSession() || currentRecognition !== recognition || sessionFinished) return;
      const errorName = event.error || "unknown";
      if (["not-allowed", "service-not-allowed"].includes(errorName)) {
        logVoice("error", "Speech recognition permission was denied. Allow microphone access for this site.", errorName);
        sessionFinished = true;
        window.clearTimeout(timeoutTimer);
        stopRecognition();
        stopRecording();
        setStatus("Microphone permission is required. Allow access in your browser settings and try again.");
        return;
      }
      if (["no-speech", "network", "aborted"].includes(errorName)) {
        logVoice("warn", `Speech recognition ${errorName}; continuing to listen.`, { sessionId });
      } else {
        logVoice("error", "Speech recognition error; continuing until the timeout.", { sessionId, error: errorName });
      }

      window.clearTimeout(recognitionRecoveryTimer);
      recognitionRecoveryTimer = window.setTimeout(() => {
        if (!isCurrentSession() || currentRecognition !== recognition || sessionFinished || !recognitionRunning) return;
        recognitionRunning = false;
        try {
          recognition.abort();
        } catch (error) {
          logVoice("warn", "Speech recognition recovery cleanup failed.", error);
        }
        scheduleRecognitionRestart();
      }, 2000);
    });
    recognition.addEventListener("end", () => {
      if (!isCurrentSession() || currentRecognition !== recognition || sessionFinished) return;
      recognitionRunning = false;
      logVoice("info", "Speech recognition ended.", { sessionId });
      window.clearTimeout(recognitionRecoveryTimer);
      scheduleRecognitionRestart();
    });

    try {
      recognition.start();
    } catch (error) {
      recognitionRunning = false;
      logVoice("error", "Speech recognition could not start; it will be retried.", error);
      scheduleRecognitionRestart(1000);
    }
  }

  function queueRecordingChunk(blob) {
    if (!blob?.size) {
      logVoice("warn", "MediaRecorder emitted an empty audio chunk.", { sessionId });
      return;
    }
    capturedChunkCount += 1;
    capturedAudioBytes += blob.size;
    const chunkIndex = nextChunkIndex;
    nextChunkIndex += 1;
    const partCount = Math.ceil(blob.size / MAX_UPLOAD_PART_BYTES);
    const parts = [];
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      const start = partIndex * MAX_UPLOAD_PART_BYTES;
      parts.push(blob.slice(start, Math.min(start + MAX_UPLOAD_PART_BYTES, blob.size)));
    }
    logVoice("info", "Audio chunk captured.", {
      sessionId, chunkIndex, bytes: blob.size, partCount, mimeType: blob.type || mimeType || "browser default"
    });
    const write = persistRecordingParts(sessionId, chunkIndex, partCount, extension, parts);
    pendingChunkWrites.push(write);
    void write.catch((error) => logVoice("error", "Could not persist an audio chunk locally.", {
      sessionId, chunkIndex, error
    }));
  }

  async function finalizeRecording() {
    if (!nextChunkIndex) {
      logVoice("error", "No audio data was captured from the microphone.", { sessionId });
      return false;
    }
    await Promise.all(pendingChunkWrites);
    await persistRecordingFinalization(sessionId, nextChunkIndex - 1, extension);
    logVoice("info", "Recording stored locally and queued for upload.", {
      sessionId,
      durationMs: Math.round(performance.now() - recordingStartedAt),
      chunkCount: capturedChunkCount,
      mimeType: recorder?.mimeType || mimeType || "browser default",
      totalAudioBytes: capturedAudioBytes,
      finalChunk: nextChunkIndex - 1
    });
    void processRecordingUpload(sessionId);
    return true;
  }

  function stopRecording() {
    if (recordingStopped) return;
    if (!recorder || recorder.state === "inactive") {
      recordingStopped = true;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      void finishRecording();
      return;
    }
    recordingStopped = true;
    logVoice("info", "Stopping MediaRecorder.", { sessionId, state: recorder.state });
    try {
      recorder.stop();
    } catch (error) {
      logVoice("error", "Could not stop the voice recording.", error);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      void finishRecording();
    }
  }

  async function finishRecording() {
    if (recordingFinalizationStarted) return;
    recordingFinalizationStarted = true;
    try {
      await finalizeRecording();
    } catch (error) {
      logVoice("error", "Could not save the recording to local browser storage.", { sessionId, error });
      setStatus("The recording could not be queued for upload. Check browser storage permissions.");
    }
    logVoice("info", "Voice recording stopped.", {
      sessionId,
      durationMs: recordingStartedAt ? Math.round(performance.now() - recordingStartedAt) : 0,
      chunkCount: capturedChunkCount,
      mimeType: recorder?.mimeType || mimeType || "browser default",
      totalAudioBytes: capturedAudioBytes
    });
    if (helloDetected) {
      logVoice("info", "Opening the surprise without waiting for the recording upload.", { sessionId });
      navigateToBirthday();
    } else if (isCurrentSession()) {
      flowerButton.disabled = false;
      flowerButton.classList.remove("is-listening");
      logVoice("info", "Voice session cleanup completed.", { sessionId });
    }
  }

  try {
    if (window.isSecureContext === false) {
      throw new Error("Microphone access requires a secure HTTPS page.");
    }
    setStatus("Listening for “hello”…");
    startRecognition();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCurrentSession() || sessionFinished) {
      stream.getTracks().forEach((track) => track.stop());
      if (helloDetected) navigateToBirthday();
      return;
    }
    logVoice("info", "Microphone permission granted.", { sessionId });
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    extension = recordingExtension(recorder.mimeType || mimeType || "audio/webm");
    logVoice("info", "MediaRecorder created.", { sessionId, mimeType: recorder.mimeType || "browser default" });
    recorder.addEventListener("start", () => {
      logVoice("info", "MediaRecorder started.", {
        sessionId, state: recorder.state, mimeType: recorder.mimeType || "browser default"
      });
    });
    ["pause", "resume"].forEach((eventName) => {
      recorder.addEventListener(eventName, () => {
        logVoice("info", `MediaRecorder ${eventName} event.`, { sessionId, state: recorder.state });
      });
    });
    recorder.addEventListener("dataavailable", (event) => {
      if (!isCurrentSession()) return;
      queueRecordingChunk(event.data);
    });
    recorder.addEventListener("stop", () => {
      logVoice("info", "MediaRecorder stopped; final dataavailable event has been handled.", { sessionId });
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (!isCurrentSession()) {
        logVoice("info", "Ignored stale voice-session stop callback.", { sessionId });
        return;
      }
      void finishRecording();
    });

    recorder.addEventListener("error", (event) => {
      logVoice("error", "MediaRecorder failed.", event.error || event);
      if (!isCurrentSession() || sessionFinished) return;
      sessionFinished = true;
      window.clearTimeout(timeoutTimer);
      stopRecognition();
      stopRecording();
      setStatus("Recording failed. Please try again.");
    });

    recorder.start(1000);
    if (recorder.state !== "recording") {
      throw new Error(`MediaRecorder did not enter recording state (state: ${recorder.state}).`);
    }
    recordingStartedAt = performance.now();
    logVoice("info", "MediaRecorder is recording.", { sessionId });
    setStatus("Microphone ready — say “hello” to continue.");
    timeoutTimer = window.setTimeout(() => {
      if (!isCurrentSession() || sessionFinished) return;
      logVoice("warn", "Voice recognition timeout reached.", { sessionId });
      sessionFinished = true;
      window.clearTimeout(recognitionRestartTimer);
      stopRecognition();
      setStatus("No speech detected. Please try again.");
      stopRecording();
    }, RECORDING_LIMIT_MS);

  } catch (error) {
    logVoice("error", "Voice unlock could not start. Check HTTPS, microphone permission, and browser support.", error);
    sessionFinished = true;
    window.clearTimeout(timeoutTimer);
    if (currentRecognition) stopRecognition();
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (stopError) {
        logVoice("error", "Recording cleanup failed.", stopError);
      }
    }
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (isCurrentSession()) {
      flowerButton.disabled = false;
      flowerButton.classList.remove("is-listening");
    }
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      setStatus("Microphone permission was denied. Allow it in your browser settings and try again.");
    } else if (error.name === "NotFoundError") {
      setStatus("No microphone was found on this device.");
    } else if (error.name === "NotReadableError") {
      setStatus("The microphone is busy in another app. Close it and try again.");
    } else if (error.message.includes("secure HTTPS")) {
      setStatus(error.message);
    } else {
      setStatus("Could not start voice input. Check microphone permission and try again.");
    }
    return;
  }

}

if (flowerButton) flowerButton.addEventListener("click", beginGardenUnlock);
void resumePendingRecordingUploads();

const sceneElements = [...document.querySelectorAll("[data-scene]")];
function showJourneyScene(name) {
  sceneElements.forEach((scene) => { scene.hidden = scene.dataset.scene !== name; });
  document.body.dataset.journeyScene = name;
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "celebration") startCelebration();
}

const diaryBook = document.querySelector("#diaryBook");
const openDiaryButton = document.querySelector("#openDiary");
const diaryContinue = document.querySelector("#diaryContinue");
if (openDiaryButton) {
  openDiaryButton.addEventListener("click", () => {
    diaryBook.classList.add("is-open");
    openDiaryButton.hidden = true;
    window.setTimeout(() => { diaryContinue.hidden = false; }, 950);
  });
}
if (diaryContinue) diaryContinue.addEventListener("click", () => showJourneyScene("letter"));

const letterEnvelope = document.querySelector("#letterEnvelope");
const openLetterButton = document.querySelector("#openLetter");
const loveLetter = document.querySelector("#loveLetter");
if (openLetterButton) {
  openLetterButton.addEventListener("click", () => {
    letterEnvelope.classList.add("is-open");
    openLetterButton.hidden = true;
    window.setTimeout(() => {
      loveLetter.hidden = false;
      loveLetter.classList.add("letter-unfolded");
      loveLetter.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 800);
  });
}

const chapters = [
  { year: 2019, memory: "Every beautiful story has a first page. This was ours beginning to bloom.", note: "the beginning of us", photos: [
    ["/static/image/IMG-20260908-WA0000.jpg", "A day that became a favorite"],
    ["/static/image/IMG-20260908-WA0001.jpg", "Our first little forever"]
  ] },
  { year: 2020, memory: "Even in an unusual year, we found our own little reasons to smile.", note: "close, in every season", photos: [
    ["https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=850&q=85", "Finding joy in the little things"],
    ["https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=850&q=85", "A little light, a lot of love"]
  ] },
  { year: 2021, memory: "A year of small adventures, warm conversations, and moments worth keeping.", note: "our kind of magic", photos: [
    ["https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=850&q=85", "Somewhere with you"],
    ["https://images.unsplash.com/photo-1507504031003-b417219a0fde?auto=format&fit=crop&w=850&q=85", "The laughter stayed with me"]
  ] },
  { year: 2022, memory: "More memories tucked into our pockets, more reasons to be grateful for you.", note: "another page, another smile", photos: [
    ["https://images.unsplash.com/photo-1530103862676-de8c9debad1d?auto=format&fit=crop&w=850&q=85", "A little celebration"],
    ["https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=850&q=85", "Sweetness all around"]
  ] },
  { year: 2023, memory: "Some days turn into stories we tell again and again. These are ours.", note: "my favorite company", photos: [
    ["https://images.unsplash.com/photo-1523438885200-e635ba2c371e?auto=format&fit=crop&w=850&q=85", "A day dressed in joy"],
    ["https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=850&q=85", "Flowers and forever feelings"]
  ] },
  { year: 2024, memory: "Through every change, the best part was having you somewhere in my story.", note: "here, there, always", photos: [
    ["https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=850&q=85", "A little escape together"],
    ["https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?auto=format&fit=crop&w=850&q=85", "Golden-hour kind of day"]
  ] },
  { year: 2025, memory: "A year full of tiny moments that somehow became the ones I treasure most.", note: "saved in my heart", photos: [
    ["https://images.unsplash.com/photo-1511988617509-a57c8a288659?auto=format&fit=crop&w=850&q=85", "The best days feel like this"],
    ["https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=850&q=85", "One for the memory book"]
  ] },
  { year: 2026, memory: "My favorite part of every year is that the story still has another page with you in it.", note: "today, tomorrow, all my tomorrows", photos: [
    ["https://images.unsplash.com/photo-1464349153735-7db50ed83c84?auto=format&fit=crop&w=850&q=85", "A wish made just for you"],
    ["https://images.unsplash.com/photo-1530103862676-de8c9debad1d?auto=format&fit=crop&w=850&q=85", "The birthday I get to celebrate you"],
    ["https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=850&q=85", "My person, my forever memory"]
  ] }
];

let chapterIndex = 0;
const memorySpread = document.querySelector("#memorySpread");
const photoBoard = document.querySelector("#photoBoard");
const previousYear = document.querySelector("#previousYear");
const nextYear = document.querySelector("#nextYear");

function renderChapter() {
  const chapter = chapters[chapterIndex];
  memorySpread.classList.toggle("golden-spread", chapter.year === 2026);
  document.querySelector("#chapterKicker").textContent = chapter.year === 2026 ? "the golden birthday chapter" : "a page from our story";
  document.querySelector("#chapterYear").textContent = chapter.year;
  document.querySelector("#chapterMessage").textContent = chapter.memory;
  document.querySelector("#chapterHandnote").textContent = `♡ ${chapter.note} ♡`;
  document.querySelector("#pageNumber").textContent = `${String(chapterIndex + 1).padStart(2, "0")} / ${chapters.length}`;
  document.querySelector("#pagePrompt").textContent = chapterIndex === chapters.length - 1 ? "Our story keeps blooming" : "Turn the page";
  nextYear.innerHTML = chapterIndex === chapters.length - 1 ? "The birthday wish <span>✦</span>" : "Next year <span>→</span>";
  previousYear.disabled = chapterIndex === 0;
  photoBoard.replaceChildren();

  chapter.photos.forEach(([src, caption], index) => {
    const figure = document.createElement("figure");
    figure.className = `polaroid polaroid-${index + 1}`;
    const imageFrame = document.createElement("div");
    imageFrame.className = "polaroid-image";
    const image = document.createElement("img");
    image.src = src;
    image.alt = `Memory from ${chapter.year}: ${caption}`;
    image.loading = "lazy";
    imageFrame.append(image);
    const tape = document.createElement("span");
    tape.className = "photo-tape";
    tape.setAttribute("aria-hidden", "true");
    const figcaption = document.createElement("figcaption");
    figcaption.textContent = caption;
    const sticker = document.createElement("span");
    sticker.className = "photo-sticker";
    sticker.textContent = index % 2 ? "✿" : "♡";
    sticker.setAttribute("aria-hidden", "true");
    figure.append(tape, imageFrame, figcaption, sticker);
    photoBoard.append(figure);
  });

  const progress = document.querySelector("#chapterProgress");
  progress.replaceChildren();
  chapters.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "year-dot";
    button.textContent = entry.year;
    button.setAttribute("aria-label", `Open ${entry.year} chapter`);
    button.setAttribute("aria-current", index === chapterIndex ? "step" : "false");
    button.addEventListener("click", () => turnToChapter(index));
    progress.append(button);
  });
}

function turnToChapter(index) {
  const nextIndex = Math.max(0, Math.min(chapters.length - 1, index));
  if (nextIndex === chapterIndex) return;
  memorySpread.classList.add("page-turning");
  document.querySelector("#cameraFlash").classList.add("flash-on");
  window.setTimeout(() => {
    chapterIndex = nextIndex;
    renderChapter();
    memorySpread.classList.remove("page-turning");
    document.querySelector("#cameraFlash").classList.remove("flash-on");
  }, 360);
}

if (memorySpread) renderChapter();
if (previousYear) previousYear.addEventListener("click", () => turnToChapter(chapterIndex - 1));
if (nextYear) nextYear.addEventListener("click", () => {
  if (chapterIndex === chapters.length - 1) showJourneyScene("celebration");
  else turnToChapter(chapterIndex + 1);
});

let audioContext;
let musicTimer;
let musicNote = 0;
let emotionalMusic = false;
const gardenMelody = [392, 440, 523, 440, 392, 330, 349, 392];
const heartMelody = [392, 523, 587, 523, 440, 392, 349, 330];
function playMusicNote() {
  if (!audioContext) return;
  const notes = emotionalMusic ? heartMelody : gardenMelody;
  const oscillator = audioContext.createOscillator();
  const volume = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = notes[musicNote % notes.length];
  volume.gain.setValueAtTime(0.0001, audioContext.currentTime);
  volume.gain.exponentialRampToValueAtTime(0.045, audioContext.currentTime + 0.08);
  volume.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 1.05);
  oscillator.connect(volume).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 1.1);
  musicNote += 1;
}

function updateMusicButtons(isPlaying) {
  [document.querySelector("#musicButton"), document.querySelector("#finalMusicButton")].forEach((button) => {
    if (!button) return;
    button.setAttribute("aria-pressed", String(isPlaying));
  });
  const memoryLabel = document.querySelector("#musicLabel");
  const finalLabel = document.querySelector("#finalMusicLabel");
  if (memoryLabel) memoryLabel.textContent = isPlaying ? "Pause the music" : "A little music";
  if (finalLabel) finalLabel.textContent = isPlaying ? "Pause the music" : "Stay a little longer";
}

async function toggleMusic() {
  if (audioContext.state === "suspended") await audioContext.resume();
  if (musicTimer) {
    window.clearInterval(musicTimer);
    musicTimer = null;
    updateMusicButtons(false);
    return;
  }
  playMusicNote();
  musicTimer = window.setInterval(playMusicNote, emotionalMusic ? 1250 : 1100);
  updateMusicButtons(true);
}

document.querySelectorAll("#musicButton, #finalMusicButton").forEach((button) => {
  button.addEventListener("click", () => { toggleMusic().catch(() => {}); });
});

function startCelebration() {
  emotionalMusic = true;
  document.body.classList.add("celebration-bloom");
  const cake = document.querySelector("#birthdayCake");
  window.setTimeout(() => cake.classList.add("candles-lit"), 850);
  if (musicTimer) {
    window.clearInterval(musicTimer);
    musicTimer = window.setInterval(playMusicNote, 1250);
  }
}

const beginJourney = document.querySelector("#beginJourney");
if (beginJourney) {
  beginJourney.addEventListener("click", () => {
    chapterIndex = 0;
    renderChapter();
    showJourneyScene("memories");
    toggleMusic().catch(() => {});
  });
}

if (window.location.hash === "#journey") {
  showJourneyScene("memories");
}