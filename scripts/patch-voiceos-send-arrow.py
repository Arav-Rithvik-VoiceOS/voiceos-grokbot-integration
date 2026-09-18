"""Prepare the VoiceOS arrow diff for review; never modify the installed app.

Changing app.asar and Info.plist invalidates the vendor's macOS signature and
causes VoiceOS to lose its existing Accessibility/microphone permissions.
The renderer change must ship in a properly signed VoiceOS build.
"""
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
APP = Path('/Applications/VoiceOS.app')
PATCH = ROOT / 'patches/voiceos-0.2.29-send-arrow.patch'
TARGET = 'out/renderer/assets/index-Caie2KD4.js'

if '--apply' in sys.argv:
    raise SystemExit('Installation disabled: modifying the signed app breaks macOS permissions and shortcuts. Submit the renderer diff for a signed VoiceOS build.')

subprocess.run(['codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
metadata = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
if metadata['CFBundleShortVersionString'] != '0.2.29':
    raise SystemExit('VoiceOS version changed; review its renderer before preparing this diff.')
blob = (APP / 'Contents/Resources/app.asar').read_bytes()
_, header_size, _, json_size = struct.unpack('<4I', blob[:16])
raw = blob[16:16 + json_size]
assert hashlib.sha256(raw).hexdigest() == metadata['ElectronAsarIntegrity']['Resources/app.asar']['hash']
entry = json.loads(raw)
for part in TARGET.split('/'):
    entry = entry['files'][part]
data = blob[8 + header_size:]
renderer = data[int(entry['offset']):int(entry['offset']) + entry['size']]
assert hashlib.sha256(renderer).hexdigest() == entry['integrity']['hash']
if '--verify' in sys.argv:
    print('Installed VoiceOS signature and renderer integrity verified. The round-arrow patch is not installed.')
    sys.exit(0)

stage = Path(tempfile.mkdtemp(prefix='voiceos-round-arrow-review-'))
file = stage / TARGET
file.parent.mkdir(parents=True)
file.write_bytes(renderer)
subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(PATCH)], cwd=stage, check=True)
subprocess.run(['bun', 'build', str(file), '--target', 'browser', '--external', '*', '--outfile', str(stage / 'syntax.js')], check=True, capture_output=True)
print('Diff applies and renderer syntax passes. Review copy:', file)
print('Installed VoiceOS was not changed. This requires a properly signed VoiceOS release.')
