from datetime import datetime, timezone
from pathlib import Path
import re
import unicodedata
from uuid import uuid4

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
RECORDINGS_DIR = BASE_DIR / "recordings"
RECORDINGS_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {"webm", "ogg", "wav", "mp4", "m4a"}
MAX_RECORDING_SIZE = 10 * 1024 * 1024

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_RECORDING_SIZE


def allowed_extension(filename):
	return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def normalized_transcript(value):
	value = unicodedata.normalize("NFKC", value or "").casefold()
	return re.sub(r"[^\w]+", " ", value, flags=re.UNICODE).strip()


@app.get("/")
def index():
	return render_template("index.html")


@app.get("/birthday")
def birthday():
	return render_template("birthday.html")


@app.get("/photos")
def photos():
	return render_template("page3.html")


@app.post("/api/recordings")
def upload_recording():
	recording = request.files.get("audio")
	transcript = normalized_transcript(request.form.get("transcript"))
	if recording is None or not recording.filename:
		app.logger.warning("Voice recording upload rejected: no audio file was provided.")
		return jsonify({"error": "No audio recording was provided."}), 400

	original_name = secure_filename(recording.filename)
	if not allowed_extension(original_name):
		app.logger.warning("Voice recording upload rejected: unsupported file type %s.", original_name)
		return jsonify({"error": "Unsupported audio format."}), 400

	extension = original_name.rsplit(".", 1)[1].lower()
	timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
	filename = f"voice-{timestamp}-{uuid4().hex[:10]}.{extension}"
	destination = RECORDINGS_DIR / filename
	recording.save(destination)
	size = destination.stat().st_size
	if size == 0:
		destination.unlink(missing_ok=True)
		app.logger.warning("Voice recording upload rejected: %s contained no bytes.", original_name)
		return jsonify({"error": "The audio recording is empty."}), 400
	app.logger.info("Voice recording saved: %s (%s bytes, %s)", destination, size, recording.mimetype or "unknown MIME type")

	unlocked = transcript == "hello"
	if unlocked:
		app.logger.info("Voice password accepted for recording %s.", filename)
	return jsonify({
		"ok": True,
		"unlocked": unlocked,
		"filename": filename,
		"size": size,
		"url": f"/recordings/{filename}",
	}), 201


@app.get("/api/latest-recording")
def latest_recording():
	recordings = [path for path in RECORDINGS_DIR.iterdir() if path.is_file()]
	if not recordings:
		return jsonify({"available": False})

	latest = max(recordings, key=lambda path: path.stat().st_mtime)
	return jsonify({"available": True, "url": f"/recordings/{latest.name}"})


@app.get("/recordings/<path:filename>")
def serve_recording(filename):
	return send_from_directory(RECORDINGS_DIR, filename, as_attachment=False)


@app.errorhandler(413)
def request_too_large(_error):
	return jsonify({"error": "The audio recording is too large."}), 413


if __name__ == "__main__":
	app.run(debug=True)
