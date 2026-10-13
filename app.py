from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import time
import unicodedata
from uuid import UUID
from uuid import uuid4

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
RECORDINGS_DIR = BASE_DIR / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR = RECORDINGS_DIR / ".uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {"webm", "ogg", "wav", "mp4", "m4a"}
MAX_RECORDING_SIZE = 10 * 1024 * 1024
MAX_UPLOAD_PART_SIZE = 12 * 1024
MAX_RECORDING_CHUNKS = 240

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_RECORDING_SIZE


def allowed_extension(filename):
	return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def normalized_transcript(value):
	value = unicodedata.normalize("NFKC", value or "").casefold()
	return re.sub(r"[^\w]+", " ", value, flags=re.UNICODE).strip()


def upload_paths(session_id):
	return (
		UPLOADS_DIR / session_id,
		UPLOADS_DIR / f"{session_id}.json",
		UPLOADS_DIR / f"{session_id}.final.json",
		UPLOADS_DIR / f"{session_id}.lock",
	)


def write_json_atomically(destination, data):
	temporary = destination.with_name(f"{destination.name}.{uuid4().hex}.tmp")
	try:
		temporary.write_text(json.dumps(data), encoding="utf-8")
		os.replace(temporary, destination)
	finally:
		temporary.unlink(missing_ok=True)


def finalized_upload(session_id):
	_, marker_path, _, _ = upload_paths(session_id)
	if not marker_path.is_file():
		return None
	return json.loads(marker_path.read_text(encoding="utf-8"))


def assemble_chunked_recording(session_id, retry_after_lock=True):
	session_dir, marker_path, finalization_path, lock_path = upload_paths(session_id)
	if marker_path.is_file():
		return json.loads(marker_path.read_text(encoding="utf-8"))

	try:
		lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
	except FileExistsError:
		if retry_after_lock:
			deadline = time.monotonic() + 2
			while time.monotonic() < deadline:
				if marker_path.is_file():
					return json.loads(marker_path.read_text(encoding="utf-8"))
				if not lock_path.exists():
					return assemble_chunked_recording(session_id, retry_after_lock=False)
				time.sleep(0.01)
		return None

	try:
		os.close(lock_fd)
		if marker_path.is_file():
			return json.loads(marker_path.read_text(encoding="utf-8"))

		if not finalization_path.is_file():
			return None

		finalization = json.loads(finalization_path.read_text(encoding="utf-8"))
		final_index = finalization["final_chunk"]
		extension = finalization["extension"]
		chunks_dir = session_dir / "chunks"
		ordered_parts = []
		total_size = 0
		for chunk_index in range(final_index + 1):
			descriptor_path = chunks_dir / f"chunk_{chunk_index:06d}.json"
			if not descriptor_path.is_file():
				return None
			descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
			if descriptor.get("extension") != extension:
				raise ValueError("Recording chunks use inconsistent audio formats.")
			for part_index in range(descriptor["parts"]):
				part_path = chunks_dir / f"chunk_{chunk_index:06d}" / f"part_{part_index:04d}.bin"
				if not part_path.is_file():
					return None
				total_size += part_path.stat().st_size
				if total_size > MAX_RECORDING_SIZE:
					raise ValueError("The audio recording is too large.")
				ordered_parts.append(part_path)

		timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
		filename = f"recording_{timestamp}_{session_id.replace('-', '')}.{extension}"
		destination = RECORDINGS_DIR / filename
		temporary = session_dir / f"recording-{uuid4().hex}.tmp"
		try:
			with temporary.open("wb") as output:
				for part_path in ordered_parts:
					with part_path.open("rb") as part:
						shutil.copyfileobj(part, output)
			os.replace(temporary, destination)
		finally:
			temporary.unlink(missing_ok=True)

		result = {"success": True, "complete": True, "filename": filename, "size": total_size}
		write_json_atomically(marker_path, result)
		shutil.rmtree(session_dir, ignore_errors=True)
		app.logger.info("Voice recording saved: %s (%s bytes)", filename, total_size)
		return result
	finally:
		lock_path.unlink(missing_ok=True)


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
	timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
	filename = f"recording_{timestamp}_{uuid4().hex}.{extension}"
	destination = RECORDINGS_DIR / filename
	recording.save(destination)
	size = destination.stat().st_size
	if size == 0:
		destination.unlink(missing_ok=True)
		app.logger.warning("Voice recording upload rejected: %s contained no bytes.", original_name)
		return jsonify({"error": "The audio recording is empty."}), 400
	app.logger.info("Voice recording saved: %s (%s bytes, %s)", filename, size, recording.mimetype or "unknown MIME type")

	unlocked = transcript == "hello"
	if unlocked:
		app.logger.info("Voice password accepted for recording %s.", filename)
	return jsonify({
		"success": True,
		"ok": True,
		"unlocked": unlocked,
		"filename": filename,
		"size": size,
		"url": f"/recordings/{filename}",
	}), 201


@app.post("/api/recordings/<session_id>/chunks/<int:chunk_index>/<int:part_index>")
def upload_recording_chunk(session_id, chunk_index, part_index):
	try:
		session_id = str(UUID(session_id))
	except ValueError:
		return jsonify({"success": False, "error": "Invalid recording session."}), 400

	complete = finalized_upload(session_id)
	if complete:
		return jsonify(complete), 200

	extension = request.args.get("extension", "").lower()
	try:
		part_count = int(request.args.get("parts", ""))
	except ValueError:
		part_count = 0
	if request.content_length is not None and request.content_length > MAX_UPLOAD_PART_SIZE:
		return jsonify({"success": False, "error": "Recording chunk is too large."}), 413
	payload = request.get_data(cache=False)
	if extension not in ALLOWED_EXTENSIONS:
		return jsonify({"success": False, "error": "Unsupported audio format."}), 400
	if (
		chunk_index < 0
		or chunk_index >= MAX_RECORDING_CHUNKS
		or part_count < 1
		or part_count > 1024
		or part_index < 0
		or part_index >= part_count
	):
		return jsonify({"success": False, "error": "Invalid recording chunk."}), 400
	if not payload or len(payload) > MAX_UPLOAD_PART_SIZE:
		return jsonify({"success": False, "error": "Invalid recording chunk size."}), 400

	session_dir, _, _, _ = upload_paths(session_id)
	chunks_dir = session_dir / "chunks"
	chunk_dir = chunks_dir / f"chunk_{chunk_index:06d}"
	chunk_dir.mkdir(parents=True, exist_ok=True)
	part_path = chunk_dir / f"part_{part_index:04d}.bin"
	temporary_part = part_path.with_name(f"{part_path.name}.{uuid4().hex}.tmp")
	try:
		temporary_part.write_bytes(payload)
		os.replace(temporary_part, part_path)
	finally:
		temporary_part.unlink(missing_ok=True)

	descriptor_path = chunks_dir / f"chunk_{chunk_index:06d}.json"
	write_json_atomically(descriptor_path, {
		"parts": part_count,
		"extension": extension,
	})

	try:
		result = assemble_chunked_recording(session_id)
	except (OSError, ValueError) as error:
		app.logger.exception("Voice recording assembly failed for session %s.", session_id)
		return jsonify({"success": False, "error": str(error)}), 400
	if result:
		return jsonify(result), 201
	return jsonify({"success": True, "complete": False}), 202


@app.post("/api/recordings/<session_id>/complete")
def complete_chunked_recording(session_id):
	try:
		session_id = str(UUID(session_id))
	except ValueError:
		return jsonify({"success": False, "error": "Invalid recording session."}), 400

	complete = finalized_upload(session_id)
	if complete:
		return jsonify(complete), 200

	metadata = request.get_json(silent=True)
	if not isinstance(metadata, dict):
		return jsonify({"success": False, "error": "Invalid recording completion metadata."}), 400
	try:
		final_chunk = int(metadata.get("final_chunk", -1))
	except (TypeError, ValueError):
		final_chunk = -1
	extension = str(metadata.get("extension", "")).lower()
	if final_chunk < 0 or final_chunk >= MAX_RECORDING_CHUNKS or extension not in ALLOWED_EXTENSIONS:
		return jsonify({"success": False, "error": "Invalid recording completion metadata."}), 400

	session_dir, _, finalization_path, _ = upload_paths(session_id)
	if not finalization_path.is_file():
		write_json_atomically(finalization_path, {
			"final_chunk": final_chunk,
			"extension": extension,
		})
	try:
		result = assemble_chunked_recording(session_id)
	except (OSError, ValueError) as error:
		app.logger.exception("Voice recording assembly failed for session %s.", session_id)
		return jsonify({"success": False, "error": str(error)}), 400
	if result:
		return jsonify(result), 201
	app.logger.info("Voice recording completion queued for session %s.", session_id)
	return jsonify({"success": True, "complete": False, "filename": None}), 202


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
	return jsonify({"success": False, "error": "The audio recording is too large."}), 413


if __name__ == "__main__":
	app.run(debug=True)
