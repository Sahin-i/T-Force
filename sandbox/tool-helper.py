#!/usr/bin/env python3
"""Small Docker-only file tools. The browser/backend never executes this on the host."""
import base64
import io
import json
import os
from pathlib import Path
import sys

ROOT = Path('/workspace').resolve()
MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_INSPECTION_BYTES = 256 * 1024


class ToolFailure(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def safe_path(value):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ToolFailure('INVALID_PATH', 'Supply a nonempty file path inside /workspace.')
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    # Refuse traversal even if normalization would happen to return to workspace.
    if '..' in path.parts:
        raise ToolFailure('INVALID_PATH', 'Parent traversal is not allowed.')
    resolved = path.resolve()
    if resolved == ROOT or not resolved.is_relative_to(ROOT):
        raise ToolFailure('INVALID_PATH', 'The file path must resolve inside /workspace.')
    return resolved


def read(args):
    path = safe_path(args['path'])
    if not path.is_file():
        raise ToolFailure('FILE_NOT_FOUND', 'The requested file does not exist or is not a regular file.')
    size = path.stat().st_size
    # Inspect image content, not just its extension. Common containers are returned
    # directly; GIF is flattened to its first frame for provider compatibility.
    from PIL import Image, ImageOps, UnidentifiedImageError
    Image.MAX_IMAGE_PIXELS = 25_000_000
    try:
        with Image.open(path) as picture:
            if picture.format not in ('PNG', 'JPEG', 'WEBP', 'GIF'):
                raise ToolFailure('UNSUPPORTED_IMAGE', 'Use PNG, JPEG, WebP or GIF for image inspection.')
            if size > MAX_IMAGE_BYTES:
                raise ToolFailure('IMAGE_TOO_LARGE', 'Image reads are limited to 8 MiB. Resize the image with Python first.')
            original = picture.size
            source_format = picture.format
            picture.seek(0)
            picture.load()
            note = ''
            if size > MAX_INSPECTION_BYTES:
                # Send an inspection copy rather than inflating canonical model
                # state with megabytes of base64. The workspace original stays exact.
                rendered = ImageOps.exif_transpose(picture).convert('RGBA')
                rendered.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                white = Image.new('RGBA', rendered.size, (255, 255, 255, 255))
                rendered = Image.alpha_composite(white, rendered).convert('RGB')
                data = None
                for _ in range(6):
                    for quality in (85, 75, 65, 55):
                        buf = io.BytesIO()
                        rendered.save(buf, format='JPEG', quality=quality, optimize=True)
                        candidate = buf.getvalue()
                        if len(candidate) <= MAX_INSPECTION_BYTES:
                            data = candidate
                            break
                    if data is not None:
                        break
                    rendered.thumbnail((max(1, int(rendered.width * 0.75)), max(1, int(rendered.height * 0.75))), Image.Resampling.LANCZOS)
                if data is None:
                    raise ToolFailure('IMAGE_TOO_LARGE', 'Unable to fit an inspection image within 256 KiB. Downsample it with Python through bash first.')
                mime = 'image/jpeg'
                note = f'Inspection copy resized/compressed as JPEG: {rendered.width} × {rendered.height} pixels, {len(data)} bytes, quality {quality}; transparency flattened on white.'
            elif source_format == 'GIF' or max(original) > 2048:
                rendered = picture.convert('RGBA' if picture.mode in ('RGBA', 'P') else 'RGB')
                rendered.thumbnail((2048, 2048))
                buf = io.BytesIO()
                rendered.save(buf, format='PNG')
                data = buf.getvalue()
                mime = 'image/png'
                note = f'Inspection copy rendered as PNG: {rendered.width} × {rendered.height} pixels, {len(data)} bytes.'
            else:
                data = path.read_bytes()
                mime = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}[source_format]
                note = 'Inspection uses the original image bytes.'
            if len(data) > MAX_IMAGE_BYTES:
                raise ToolFailure('IMAGE_TOO_LARGE', 'Rendered image exceeds the 8 MiB inspection limit. Resize it with Python first.')
            if source_format == 'GIF':
                note += ' GIF inspection shows the first frame only.'
            return {'ok': True, 'output': f'Image {path}: original {original[0]} × {original[1]} pixels, {size} bytes. {note} The original workspace file is unchanged.', 'images': [{'mime': mime, 'data': base64.b64encode(data).decode('ascii')}]}
    except (UnidentifiedImageError, OSError):
        pass
    except Image.DecompressionBombError:
        raise ToolFailure('IMAGE_TOO_LARGE', 'Image has too many pixels for direct inspection. Resize it first.')
    if size > MAX_TEXT_FILE_BYTES:
        raise ToolFailure('FILE_TOO_LARGE', 'Direct text reads are limited to 16 MiB. Inspect selected contents with bash.')
    raw = path.read_bytes()
    if b'\x00' in raw:
        raise ToolFailure('BINARY_FILE', 'This file is binary. Process DOCX/XLSX/PDF through the installed Python libraries; render PDF pages to PNG for inspection.')
    try:
        content = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ToolFailure('BINARY_FILE', 'Direct text reads require UTF-8. Use Python to inspect or convert this file.')
    offset = args.get('offset') or 1
    limit = args.get('limit') or 200
    lines = content.splitlines(keepends=True)
    chosen = ''.join(lines[offset - 1:offset - 1 + limit])
    budget = args['maxOutputBytes']
    selected = chosen.encode('utf-8')
    truncated = len(selected) > budget or offset - 1 + limit < len(lines)
    chosen = selected[:budget].decode('utf-8', errors='ignore')
    return {'ok': True, 'output': chosen, 'path': str(path), 'offset': offset, 'totalLines': len(lines), 'truncated': truncated}


def write(args):
    path = safe_path(args['path'])
    data = args['content'].encode('utf-8')
    if len(data) > MAX_TEXT_FILE_BYTES:
        raise ToolFailure('FILE_TOO_LARGE', 'Writes are limited to 16 MiB.')
    path.parent.mkdir(parents=True, exist_ok=True)
    # Recheck after creating the parents, including any symlink parents.
    path = safe_path(str(path))
    path.write_bytes(data)
    return {'ok': True, 'output': f'Wrote {len(data)} bytes to {path}.'}


def edit(args):
    path = safe_path(args['path'])
    if not path.is_file():
        raise ToolFailure('FILE_NOT_FOUND', 'The file to edit does not exist.')
    if path.stat().st_size > MAX_TEXT_FILE_BYTES:
        raise ToolFailure('FILE_TOO_LARGE', 'Edits are limited to files smaller than 16 MiB.')
    try:
        with path.open('r', encoding='utf-8', newline='') as source:
            content = source.read()
    except UnicodeDecodeError:
        raise ToolFailure('BINARY_FILE', 'Exact edits require UTF-8 text.')
    old = args['oldText']
    if not old:
        raise ToolFailure('INVALID_ARGUMENTS', 'oldText must not be empty.')
    # Count overlapping occurrences too: "aa" is ambiguous in "aaa".
    count = 0
    position = content.find(old)
    while position != -1 and count < 2:
        count += 1
        position = content.find(old, position + 1)
    if count == 0:
        raise ToolFailure('MATCH_NOT_FOUND', 'oldText does not match the file exactly. Read the file before editing.')
    if count != 1:
        raise ToolFailure('AMBIGUOUS_MATCH', 'oldText appears more than once. Include more surrounding text to identify one match.')
    updated = content.replace(old, args['newText'], 1)
    if len(updated.encode('utf-8')) > MAX_TEXT_FILE_BYTES:
        raise ToolFailure('FILE_TOO_LARGE', 'The edited file would exceed 16 MiB.')
    path.write_text(updated, encoding='utf-8', newline='')
    return {'ok': True, 'output': f'Replaced one exact match in {path}.'}


def main():
    try:
        payload = sys.stdin.read(64 * 1024 * 1024 + 1)
        if len(payload) > 64 * 1024 * 1024:
            raise ToolFailure('INVALID_ARGUMENTS', 'File-tool input exceeds the transfer limit.')
        args = json.loads(payload)
        operation = {'read': read, 'write': write, 'edit': edit}.get(sys.argv[1])
        if operation is None:
            raise ToolFailure('UNKNOWN_TOOL', 'Unknown file operation.')
        response = operation(args)
    except ToolFailure as error:
        response = {'ok': False, 'output': '', 'error': {'code': error.code, 'message': str(error)}}
    except (OSError, ValueError, KeyError, IndexError) as error:
        response = {'ok': False, 'output': '', 'error': {'code': 'FILE_OPERATION_FAILED', 'message': str(error)}}
    print(json.dumps(response, ensure_ascii=False))


if __name__ == '__main__':
    main()
