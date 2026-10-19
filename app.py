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
from flask_cors import CORS
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", str(BASE_DIR / "recordings"))).expanduser().resolve()
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR = RECORDINGS_DIR / ".uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {"webm", "ogg", "wav", "mp4", "m4a"}
MAX_RECORDING_SIZE = 10 * 1024 * 1024
MAX_UPLOAD_PART_SIZE = 12 * 1024
MAX_RECORDING_CHUNKS = 240

app = Flask(__name__)
CORS(
    app,
    resources={
        r"/api/*": {
            "origins": [
                "https://dhanapriya682008-oss.github.io"
            ]
        }
    }
)
app.config["MAX_CONTENT_LENGTH"] = MAX_RECORDING_SIZE
app.logger.info("Voice recording storage directory: %s", RECORDINGS_DIR)


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
	return validate_completed_recording(json.loads(marker_path.read_text(encoding="utf-8")))


def validate_completed_recording(result):
	if not isinstance(result, dict):
		raise ValueError("The completed recording marker is invalid.")
	filename = result.get("filename")
	size = result.get("size")
	if (
		result.get("success") is not True
		or result.get("complete") is not True
		or not isinstance(filename, str)
		or secure_filename(filename) != filename
		or not isinstance(size, int)
		or size <= 0
	):
		raise ValueError("The completed recording marker is invalid.")
	destination = RECORDINGS_DIR / filename
	try:
		actual_size = destination.stat().st_size
	except OSError:
		app.logger.exception("Completed recording file is missing: %s", destination)
		raise
	if actual_size <= 0 or actual_size != size:
		app.logger.error(
			"Completed recording file size mismatch: path=%s marker_size=%d actual_size=%d",
			destination,
			size,
			actual_size,
		)
		raise OSError(f"Completed recording file is missing or incomplete: {destination}.")
	return result


def missing_recording_parts(session_id, final_chunk):
	session_dir, _, _, _ = upload_paths(session_id)
	chunks_dir = session_dir / "chunks"
	missing = []
	for chunk_index in range(final_chunk + 1):
		descriptor_path = chunks_dir / f"chunk_{chunk_index:06d}.json"
		if not descriptor_path.is_file():
			missing.append(f"chunk {chunk_index}: descriptor")
			continue
		descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
		for part_index in range(descriptor["parts"]):
			part_path = chunks_dir / f"chunk_{chunk_index:06d}" / f"part_{part_index:04d}.bin"
			if not part_path.is_file():
				missing.append(f"chunk {chunk_index}: part {part_index}")
	return missing


def assemble_chunked_recording(session_id, retry_after_lock=True):
	session_dir, marker_path, finalization_path, lock_path = upload_paths(session_id)
	if marker_path.is_file():
		return validate_completed_recording(json.loads(marker_path.read_text(encoding="utf-8")))

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
			if not destination.is_file():
				raise OSError(f"Assembled recording was not created at {destination}.")
			saved_size = destination.stat().st_size
			if saved_size <= 0 or saved_size != total_size:
				destination.unlink(missing_ok=True)
				raise OSError(
					f"Assembled recording size mismatch at {destination}: expected {total_size}, got {saved_size}."
				)
		finally:
			temporary.unlink(missing_ok=True)

		result = {"success": True, "complete": True, "filename": filename, "size": saved_size}
		write_json_atomically(marker_path, result)
		shutil.rmtree(session_dir, ignore_errors=True)
		app.logger.info("Voice recording saved: path=%s size=%d bytes", destination, saved_size)
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
	try:
		recording.save(destination)
		size = destination.stat().st_size
	except OSError:
		app.logger.exception("Could not write voice recording to %s.", destination)
		return jsonify({"success": False, "error": "The recording could not be saved on the server."}), 500
	if size == 0:
		destination.unlink(missing_ok=True)
		app.logger.warning("Voice recording upload rejected: %s contained no bytes.", original_name)
		return jsonify({"error": "The audio recording is empty."}), 400
	app.logger.info(
		"Voice recording saved: path=%s size=%d bytes mime=%s",
		destination,
		size,
		recording.mimetype or "unknown MIME type",
	)

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

	try:
		complete = finalized_upload(session_id)
	except (OSError, ValueError, KeyError, TypeError):
		app.logger.exception("Could not verify completed recording for session %s.", session_id)
		return jsonify({"success": False, "error": "The saved recording could not be verified."}), 500
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
	descriptor_path = chunks_dir / f"chunk_{chunk_index:06d}.json"
	if descriptor_path.is_file():
		existing = json.loads(descriptor_path.read_text(encoding="utf-8"))
		if existing.get("parts") != part_count or existing.get("extension") != extension:
			app.logger.error(
				"Conflicting chunk metadata: session=%s chunk=%d existing=%s received_parts=%d extension=%s",
				session_id,
				chunk_index,
				existing,
				part_count,
				extension,
			)
			return jsonify({"success": False, "error": "Conflicting audio chunk metadata."}), 409
	part_path = chunk_dir / f"part_{part_index:04d}.bin"
	temporary_part = part_path.with_name(f"{part_path.name}.{uuid4().hex}.tmp")
	try:
		temporary_part.write_bytes(payload)
		os.replace(temporary_part, part_path)
	except OSError:
		app.logger.exception(
			"Could not save audio part: session=%s chunk=%d part=%d path=%s",
			session_id,
			chunk_index,
			part_index,
			part_path,
		)
		return jsonify({"success": False, "error": "The audio chunk could not be saved on the server."}), 500
	finally:
		temporary_part.unlink(missing_ok=True)

	try:
		write_json_atomically(descriptor_path, {
			"parts": part_count,
			"extension": extension,
		})
	except OSError:
		app.logger.exception(
			"Could not save audio chunk metadata: session=%s chunk=%d path=%s",
			session_id,
			chunk_index,
			descriptor_path,
		)
		return jsonify({"success": False, "error": "The audio chunk metadata could not be saved."}), 500
	app.logger.info(
		"Audio chunk stored: session=%s chunk=%d part=%d/%d bytes=%d",
		session_id,
		chunk_index,
		part_index,
		part_count,
		len(payload),
	)

	try:
		result = assemble_chunked_recording(session_id)
	except ValueError as error:
		app.logger.exception("Voice recording assembly failed for session %s.", session_id)
		return jsonify({"success": False, "error": str(error)}), 400
	except OSError:
		app.logger.exception("Could not write assembled voice recording for session %s.", session_id)
		return jsonify({"success": False, "error": "The recording could not be saved on the server."}), 500
	if result:
		return jsonify(result), 201
	return jsonify({"success": True, "complete": False}), 202


@app.post("/api/recordings/<session_id>/complete")
def complete_chunked_recording(session_id):
	try:
		session_id = str(UUID(session_id))
	except ValueError:
		return jsonify({"success": False, "error": "Invalid recording session."}), 400

	try:
		complete = finalized_upload(session_id)
	except (OSError, ValueError, KeyError, TypeError):
		app.logger.exception("Could not verify completed recording for session %s.", session_id)
		return jsonify({"success": False, "error": "The saved recording could not be verified."}), 500
	if complete:
		return jsonify(complete), 200

	metadata = request.get_json(silent=True)
	if not isinstance(metadata, dict) and request.mimetype == "application/x-www-form-urlencoded":
		metadata = request.form.to_dict()
	if not isinstance(metadata, dict):
		return jsonify({"success": False, "error": "Invalid recording completion metadata."}), 400
	try:
		final_chunk = int(metadata.get("final_chunk", -1))
	except (TypeError, ValueError):
		final_chunk = -1
	extension = str(metadata.get("extension", "")).lower()
	if final_chunk < 0 or final_chunk >= MAX_RECORDING_CHUNKS or extension not in ALLOWED_EXTENSIONS:
		return jsonify({"success": False, "error": "Invalid recording completion metadata."}), 400

	_, _, finalization_path, _ = upload_paths(session_id)
	finalization = {"final_chunk": final_chunk, "extension": extension}
	if finalization_path.is_file():
		existing = json.loads(finalization_path.read_text(encoding="utf-8"))
		if existing != finalization:
			app.logger.error(
				"Conflicting recording finalization: session=%s existing=%s received=%s",
				session_id,
				existing,
				finalization,
			)
			return jsonify({"success": False, "error": "Conflicting recording finalization."}), 409
	else:
		try:
			write_json_atomically(finalization_path, {
				"final_chunk": final_chunk,
				"extension": extension,
			})
		except OSError:
			app.logger.exception(
				"Could not save recording finalization metadata: session=%s path=%s",
				session_id,
				finalization_path,
			)
			return jsonify({"success": False, "error": "Recording completion metadata could not be saved."}), 500
	try:
		result = assemble_chunked_recording(session_id)
	except ValueError as error:
		app.logger.exception("Voice recording assembly failed for session %s.", session_id)
		return jsonify({"success": False, "error": str(error)}), 400
	except OSError:
		app.logger.exception("Could not write assembled voice recording for session %s.", session_id)
		return jsonify({"success": False, "error": "The recording could not be saved on the server."}), 500
	if result:
		return jsonify(result), 201
	try:
		missing = missing_recording_parts(session_id, final_chunk)
	except (OSError, ValueError, KeyError, TypeError) as error:
		app.logger.exception("Could not inspect pending recording session %s.", session_id)
		return jsonify({"success": False, "error": "Could not inspect the uploaded recording."}), 500
	app.logger.warning(
		"Recording assembly pending: session=%s final_chunk=%d missing_parts=%d first_missing=%s",
		session_id,
		final_chunk,
		len(missing),
		missing[:10],
	)
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
