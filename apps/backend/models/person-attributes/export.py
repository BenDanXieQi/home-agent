"""Export the fixed official PP-Human attribute model with Paddle2ONNX."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

import paddle2onnx

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
args = parser.parse_args()
archive = args.archive.read_bytes()
if hashlib.sha256(archive).hexdigest() != "d1d28223d1ff7a1b0b1ff2e9af6747df143c228ec6e9bd78e7f91ab6b2ced5df":
    raise ValueError("Official PP-Human archive fingerprint mismatch")

directory = Path(__file__).resolve().parent
profile = json.loads((directory / "profile.json").read_text())
with tempfile.TemporaryDirectory() as temporary:
    source = Path(temporary)
    with zipfile.ZipFile(args.archive) as packed:
        for name in ("inference.pdmodel", "inference.pdiparams"):
            (source / name).write_bytes(packed.read(f"PPLCNet_x1_0_person_attribute_945_infer/{name}"))
    model = paddle2onnx.export(
        str(source / "inference.pdmodel"),
        str(source / "inference.pdiparams"),
        opset_version=11,
        verbose=False,
        enable_onnx_checker=True,
    )
if hashlib.sha256(model).hexdigest() != profile["sha256"]:
    raise ValueError("Converted ONNX fingerprint differs from profile.json")
(directory / "model.onnx").write_bytes(model)
print(f"Exported {directory / 'model.onnx'}")
