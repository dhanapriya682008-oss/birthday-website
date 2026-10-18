const flowerButton = document.querySelector("#flowerButton");
const voiceStatus = document.querySelector("#voiceStatus");
const API_BASE_URL = "https://birthday-website-1-dhd2.onrender.com";
const RECORDING_LIMIT_MS = 120000;
const MAX_UPLOAD_PART_BYTES = 12 * 1024;

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
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]
    .find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
}

function recordingExtension(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}

async function beginGardenUnlock() {
  if (!flowerButton || flowerButton.disabled) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    console.error("Voice unlock is unavailable. Use HTTPS and a browser with microphone and speech-recognition support (for example, Chrome on Android).");
    if (voiceStatus) voiceStatus.textContent = "Voice unlock is not available in this browser.";
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
  let uploadCompleted = false;
  let uploadStarted = false;
  let nextChunkIndex = 0;
  const uploadQueue = [];
  let uploadQueueRunning = false;
  let navigationStarted = false;
  const sessionId = createRecordingSessionId();
  const mimeType = chooseRecorderType();
  let extension = recordingExtension(mimeType || "audio/webm");

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
      console.debug("Speech recognition was already stopped:", error);
    }
  }

  function scheduleRecognitionRestart(delay = 250) {
    if (sessionFinished || recognitionRestartTimer) return;
    recognitionRestartTimer = window.setTimeout(() => {
      recognitionRestartTimer = null;
      startRecognition(true);
    }, delay);
  }

  function handleHello() {
    if (sessionFinished) return;
    console.info("Hello detected");
    helloDetected = true;
    sessionFinished = true;
    window.clearTimeout(timeoutTimer);
    window.clearTimeout(recognitionRestartTimer);
    window.clearTimeout(recognitionRecoveryTimer);
    console.info("Background upload started");
    stopRecognition();
    document.body.classList.add("garden-blooming");
    stopRecording();
  }

  function navigateToBirthday() {
    if (navigationStarted) return;
    navigationStarted = true;
    console.info("Navigating to birthday page");
    console.info("Navigation started");
    window.location.assign("/birthday.html");
  }

  function startRecognition(isRestart = false) {
    if (sessionFinished || recognitionRunning) return;
    const recognition = new Recognition();
    currentRecognition = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 5;

    recognition.addEventListener("start", () => {
      if (currentRecognition !== recognition || sessionFinished) return;
      recognitionRunning = true;
      console.info(isRestart ? "Recognition restarted" : "Recognition started");
    });
    recognition.addEventListener("result", (event) => {
      if (currentRecognition !== recognition || sessionFinished) return;
      const alternatives = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        for (let alternativeIndex = 0; alternativeIndex < result.length; alternativeIndex += 1) {
          const alternative = result[alternativeIndex];
          const spokenText = alternative.transcript || "";
          console.info("Recognized text:", spokenText);
          alternatives.push(normalizeSpokenWord(spokenText));
        }
      }
      if (alternatives.some((text) => text.split(" ").includes("hello"))) handleHello();
    });
    recognition.addEventListener("error", (event) => {
      if (currentRecognition !== recognition || sessionFinished) return;
      const errorName = event.error || "unknown";
      if (["no-speech", "network", "aborted"].includes(errorName)) {
        console.warn(`Speech recognition ${errorName}; continuing to listen.`);
      } else {
        console.error("Speech recognition error; continuing until the timeout:", errorName);
      }

      window.clearTimeout(recognitionRecoveryTimer);
      recognitionRecoveryTimer = window.setTimeout(() => {
        if (currentRecognition !== recognition || sessionFinished || !recognitionRunning) return;
        recognitionRunning = false;
        try {
          recognition.abort();
        } catch (error) {
          console.debug("Speech recognition recovery cleanup:", error);
        }
        scheduleRecognitionRestart();
      }, 2000);
    });
    recognition.addEventListener("end", () => {
      if (currentRecognition !== recognition || sessionFinished) return;
      recognitionRunning = false;
      window.clearTimeout(recognitionRecoveryTimer);
      scheduleRecognitionRestart();
    });

    try {
      recognition.start();
    } catch (error) {
      recognitionRunning = false;
      console.warn("Speech recognition could not start; it will be retried:", error);
      scheduleRecognitionRestart(1000);
    }
  }

  function logUploadCompleted(filename) {
    if (uploadCompleted) return;
    uploadCompleted = true;
    console.info("Upload completed", filename);
    if (helloDetected) console.info("Background upload completed");
  }

  function enqueueUpload(job) {
    uploadQueue.push(job);
    void processUploadQueue();
  }

  async function uploadPart(blob, chunkIndex, partIndex, partCount) {
    if (!uploadStarted) {
      uploadStarted = true;
      console.info("Upload started", { sessionId });
    }
    const query = new URLSearchParams({
      extension,
      parts: String(partCount)
    });
    const url = `${API_BASE_URL}/api/recordings/${sessionId}/chunks/${chunkIndex}/${partIndex}?${query}`;
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const requestTimeout = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
          keepalive: true,
          signal: controller.signal
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          const error = new Error(result.error || `HTTP ${response.status}`);
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw error;
        }
        console.info("Audio chunk accepted", {
          sessionId,
          chunkIndex,
          partIndex,
          status: response.status,
          complete: result.complete === true
        });
        if (result.complete) logUploadCompleted(result.filename);
        return;
      } catch (error) {
        lastError = error;
        console.warn("Audio chunk upload attempt failed", {
          sessionId,
          chunkIndex,
          partIndex,
          attempt: attempt + 1,
          error
        });
        if (error.retryable === false) break;
        if (attempt < 4) {
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(250 * (2 ** attempt), 4000)));
        }
      } finally {
        window.clearTimeout(requestTimeout);
      }
    }
    console.error("Audio chunk upload failed after retries", {
      sessionId,
      chunkIndex,
      partIndex,
      error: lastError
    });
    if (helloDetected) console.error("Background upload failed", lastError);
  }

  async function processUploadQueue() {
    if (uploadQueueRunning) return;
    uploadQueueRunning = true;
    try {
      while (uploadQueue.length) {
        const job = uploadQueue.shift();
        await uploadPart(job.blob, job.chunkIndex, job.partIndex, job.partCount);
      }
    } finally {
      uploadQueueRunning = false;
      if (uploadQueue.length) void processUploadQueue();
    }
  }

  function queueRecordingChunk(blob) {
    if (!blob.size) return;
    const chunkIndex = nextChunkIndex;
    nextChunkIndex += 1;
    const partCount = Math.ceil(blob.size / MAX_UPLOAD_PART_BYTES);
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      const start = partIndex * MAX_UPLOAD_PART_BYTES;
      const part = blob.slice(start, Math.min(start + MAX_UPLOAD_PART_BYTES, blob.size));
      enqueueUpload({ blob: part, chunkIndex, partIndex, partCount });
    }
  }

  async function finalizeRecording() {
    if (!nextChunkIndex) {
      console.error("No audio data was captured from the microphone.", { sessionId });
      return;
    }
    const url = `${API_BASE_URL}/api/recordings/${sessionId}/complete`;
    const body = JSON.stringify({ final_chunk: nextChunkIndex - 1, extension });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const requestTimeout = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
          signal: controller.signal
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          const error = new Error(result.error || `HTTP ${response.status}`);
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw error;
        }
        console.info("Recording finalization accepted", {
          sessionId,
          finalChunk: nextChunkIndex - 1,
          status: response.status,
          complete: result.complete === true
        });
        if (result.complete) logUploadCompleted(result.filename);
        return;
      } catch (error) {
        console.warn("Recording finalization attempt failed", {
          sessionId,
          attempt: attempt + 1,
          error
        });
        if (error.retryable === false) break;
        if (attempt < 4) {
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(250 * (2 ** attempt), 4000)));
        }
      } finally {
        window.clearTimeout(requestTimeout);
      }
    }
    console.error("Recording finalization failed after retries", { sessionId });
    if (helloDetected) console.error("Background upload failed", { sessionId });
  }

  function stopRecording() {
    if (!recorder || recorder.state === "inactive") {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (helloDetected) navigateToBirthday();
      else {
        flowerButton.disabled = false;
        flowerButton.classList.remove("is-listening");
      }
      return;
    }
    if (!recordingStopped) {
      recordingStopped = true;
      console.info("Recording stopped");
    }
    try {
      recorder.stop();
    } catch (error) {
      console.error("Could not stop the voice recording:", error);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (helloDetected) navigateToBirthday();
    }
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    extension = recordingExtension(recorder.mimeType || mimeType || "audio/webm");
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) queueRecordingChunk(event.data);
    });
    recorder.addEventListener("stop", () => {
      void finalizeRecording();
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (helloDetected) navigateToBirthday();
      else {
        flowerButton.disabled = false;
        flowerButton.classList.remove("is-listening");
      }
    });

    recorder.addEventListener("error", (event) => {
      console.error("MediaRecorder failed:", event.error || event);
      if (sessionFinished) return;
      sessionFinished = true;
      window.clearTimeout(timeoutTimer);
      stopRecognition();
      stopRecording();
      setStatus("Recording failed. Please try again.");
    });

    recorder.start(1000);
    console.info("Recording started");
    timeoutTimer = window.setTimeout(() => {
      if (sessionFinished) return;
      console.warn("Timeout reached");
      sessionFinished = true;
      window.clearTimeout(recognitionRestartTimer);
      stopRecognition();
      setStatus("No speech detected. Please try again.");
      stopRecording();
    }, RECORDING_LIMIT_MS);

    startRecognition();
  } catch (error) {
    console.error("Voice unlock could not start:", error);
    if (currentRecognition) stopRecognition();
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (stopError) {
        console.error("Recording cleanup failed:", stopError);
      }
    }
    if (stream) stream.getTracks().forEach((track) => track.stop());
    flowerButton.disabled = false;
    flowerButton.classList.remove("is-listening");
    setStatus("Microphone access is required. Please try again.");
    return;
  }

}

if (flowerButton) flowerButton.addEventListener("click", beginGardenUnlock);

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
        recognition.addEventListener("error", (event) => {
          console.error("Speech recognition failed:", event.error || event);
          finish(false);
        }, { once: true });
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