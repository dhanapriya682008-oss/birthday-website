const flowerButton = document.querySelector("#flowerButton");

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
  return transcript.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function chooseRecorderType() {
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) return "audio/ogg;codecs=opus";
  return "audio/webm";
}

async function saveVoiceRecording(blob, mimeType) {
  if (!blob.size) {
    console.error("Voice recording was empty; nothing was uploaded.");
    return false;
  }
  const extension = mimeType.includes("ogg") ? "ogg" : "webm";
  const body = new FormData();
  body.append("audio", blob, `garden-hello.${extension}`);
  try {
    const response = await fetch("/api/recordings", { method: "POST", body });
    if (!response.ok) throw new Error(`Upload returned HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.error("Voice recording upload failed:", error);
    return false;
  }
}

async function beginGardenUnlock() {
  if (!flowerButton || flowerButton.disabled) return;
  if (!("SpeechRecognition" in window || "webkitSpeechRecognition" in window) || !window.MediaRecorder) return;

  flowerButton.disabled = true;
  flowerButton.classList.add("is-listening");
  let stream;
  let recorder;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseRecorderType();
    recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });

    const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    const recognizedHello = new Promise((resolve) => {
      let settled = false;
      const finish = (matches) => {
        if (settled) return;
        settled = true;
        resolve(matches);
      };
      recognition.addEventListener("result", (event) => {
        finish(normalizeSpokenWord(event.results[0][0].transcript) === "hello");
      }, { once: true });
      recognition.addEventListener("error", () => finish(false), { once: true });
      recognition.addEventListener("end", () => finish(false), { once: true });
    });

    recorder.start();
    recognition.start();
    const unlocked = await recognizedHello;
    const stopped = new Promise((resolve) => {
      if (recorder.state === "inactive") resolve();
      else recorder.addEventListener("stop", resolve, { once: true });
    });
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    await saveVoiceRecording(new Blob(chunks, { type: mimeType }), mimeType);

    if (unlocked) {
      document.body.classList.add("garden-blooming");
      window.setTimeout(() => window.location.assign("/birthday"), 1650);
      return;
    }
  } catch (_error) {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  flowerButton.disabled = false;
  flowerButton.classList.remove("is-listening");
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
  if (!audioContext) audioContext = new AudioContext();
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