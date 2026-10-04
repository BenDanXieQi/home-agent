"""Bounded CPU face inference: official YuNet, alignment and SFace in one process."""

import base64
import hashlib
import json
import sys
from pathlib import Path

import cv2 as cv
import numpy as np

HERE = Path(__file__).resolve().parent
PROFILE = json.loads((HERE / "profile.json").read_text())
CONTRACT = json.loads((HERE / "models.json").read_text())
CAPACITY = json.loads(sys.argv[2])
MAX_LINE_BYTES = 2 * 1024 * 1024


def load_models(directory):
    paths = {}
    for name, spec in CONTRACT["models"].items():
        for file, expected in (
            (spec["file"], spec["sha256"]),
            (spec["licenseFile"], spec["licenseSha256"]),
        ):
            path = directory / file
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                    raise ValueError(f"Model or license fingerprint mismatch: {name}")
        paths[name] = str(directory / spec["file"])
    cv.setNumThreads(0)
    cv.ocl.setUseOpenCL(False)
    detector = cv.FaceDetectorYN.create(
        paths["yunet"],
        "",
        (PROFILE["width"], PROFILE["height"]),
        PROFILE["detectorScore"],
        PROFILE["nms"],
        PROFILE["topK"],
        cv.dnn.DNN_BACKEND_OPENCV,
        cv.dnn.DNN_TARGET_CPU,
    )
    recognizer = cv.FaceRecognizerSF.create(
        paths["sface"],
        "",
        cv.dnn.DNN_BACKEND_OPENCV,
        cv.dnn.DNN_TARGET_CPU,
    )
    return detector, recognizer


def analyze(request, detector, recognizer):
    raw = base64.b64decode(request["rgb"], validate=True)
    if len(raw) != PROFILE["width"] * PROFILE["height"] * 3:
        raise ValueError("Expected current-video 848x480 RGB24 frame")
    tracks, targets = request["tracks"], set(request["targets"])
    if (
        len(tracks) > CAPACITY["tracksPerRun"]
        or len(targets) > CAPACITY["facesPerFrame"]
    ):
        raise ValueError("Face inference capacity exceeded")
    rgb = np.frombuffer(raw, dtype=np.uint8).reshape(
        PROFILE["height"], PROFILE["width"], 3
    )
    image = cv.cvtColor(rgb, cv.COLOR_RGB2BGR)
    faces = detector.detect(image)[1]
    if faces is None:
        return {"samples": [], "qualityRejected": 0}
    boxes = [track["measuredBox"] for track in tracks]
    samples, used = [], set()
    rejected = 0
    for face in sorted(faces, key=lambda row: -row[-1]):
        x, y, width, height = face[:4]
        owners = [
            index
            for index, box in enumerate(boxes)
            if box["x"] <= x + width / 2 <= box["x"] + box["w"]
            and box["y"] <= y + height / 2 <= box["y"] + box["h"]
        ]
        if (
            face[-1] < PROFILE["detectorScore"]
            or min(width, height) < PROFILE["minimumFaceSide"]
            or len(owners) != 1
            or owners[0] in used
        ):
            rejected += 1
            continue
        index = owners[0]
        used.add(index)
        track_id = tracks[index]["trackId"]
        if track_id not in targets:
            continue
        aligned = recognizer.alignCrop(image, face)
        sharpness = float(
            cv.Laplacian(cv.cvtColor(aligned, cv.COLOR_BGR2GRAY), cv.CV_64F).var()
        )
        if not sharpness >= request["minimumSharpness"]:
            rejected += 1
            continue
        feature = recognizer.feature(aligned).flatten()
        if (
            feature.shape != (CAPACITY["featureDimensions"],)
            or not np.isfinite(feature).all()
            or np.linalg.norm(feature) <= 1e-12
        ):
            raise ValueError("Invalid SFace feature")
        samples.append(
            {
                "trackId": track_id,
                "feature": list(map(float, feature)),
                "cropSha256": hashlib.sha256(aligned.tobytes()).hexdigest(),
                "sharpness": sharpness,
                "detectionScore": float(face[-1]),
            }
        )
    return {"samples": samples, "qualityRejected": rejected}


def main():
    detector, recognizer = load_models(Path(sys.argv[1]))
    print(json.dumps({"kind": "ready", "opencv": cv.__version__}), flush=True)
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES:
            raise ValueError("Face request exceeds frame budget")
        result = analyze(json.loads(line), detector, recognizer)
        print(json.dumps({"kind": "result", **result}, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
