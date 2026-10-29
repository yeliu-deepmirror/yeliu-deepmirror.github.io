/**
 * Shared COLMAP sparse-model loader for the browser.
 *
 * Dependency-free: usable from classic scripts and ES modules alike via the
 * global `ColmapModelLoader`. Poses are returned as plain data so callers can
 * build their own three.js objects.
 */
(function (global) {
    'use strict';

    class BinaryReader {
        constructor(buffer) {
            this.view = new DataView(buffer);
            this.offset = 0;
        }

        ensureAvailable(byteCount) {
            if (!Number.isSafeInteger(byteCount) || byteCount < 0 || this.offset + byteCount > this.view.byteLength) {
                throw new Error(`Invalid binary data at byte ${this.offset}`);
            }
        }

        readUint8() {
            this.ensureAvailable(1);
            return this.view.getUint8(this.offset++);
        }

        readUint32() {
            this.ensureAvailable(4);
            const value = this.view.getUint32(this.offset, true);
            this.offset += 4;
            return value;
        }

        readUint64() {
            this.ensureAvailable(8);
            const low = this.view.getUint32(this.offset, true);
            const high = this.view.getUint32(this.offset + 4, true);
            this.offset += 8;
            const value = high * 2 ** 32 + low;
            if (!Number.isSafeInteger(value)) throw new Error('Binary integer exceeds JavaScript precision');
            return value;
        }

        readFloat64() {
            this.ensureAvailable(8);
            const value = this.view.getFloat64(this.offset, true);
            this.offset += 8;
            return value;
        }

        readString() {
            const start = this.offset;
            while (this.offset < this.view.byteLength && this.view.getUint8(this.offset) !== 0) this.offset += 1;
            if (this.offset === this.view.byteLength) throw new Error('Unterminated image name');
            const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + start, this.offset - start);
            this.offset += 1;
            return new TextDecoder().decode(bytes);
        }

        skip(byteCount) {
            this.ensureAvailable(byteCount);
            this.offset += byteCount;
        }
    }

    function detectFormat(fileNames) {
        const names = new Set(fileNames);
        if (names.has('images.bin') && names.has('points3D.bin')) return 'bin';
        if (names.has('images.txt') && names.has('points3D.txt')) return 'txt';
        return null;
    }

    /**
     * COLMAP stores a world-to-camera rotation (quaternion `qvec`) and translation
     * (`tvec`). The returned `rotationMatrix` is the transposed rotation, column-major
     * like `THREE.Matrix4.elements`, and `position` is the camera center in world space.
     */
    function cameraPose(qvec, tvec) {
        const [w, x, y, z] = qvec;
        const xx = x * x;
        const yy = y * y;
        const zz = z * z;
        const m = [
            1 - 2 * (yy + zz), 2 * (x * y - w * z), 2 * (x * z + w * y),
            2 * (x * y + w * z), 1 - 2 * (xx + zz), 2 * (y * z - w * x),
            2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (xx + yy)
        ];
        const [tx, ty, tz] = [-tvec[0], -tvec[1], -tvec[2]];
        return {
            position: [
                m[0] * tx + m[3] * ty + m[6] * tz,
                m[1] * tx + m[4] * ty + m[7] * tz,
                m[2] * tx + m[5] * ty + m[8] * tz
            ],
            rotationMatrix: [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1]
        };
    }

    async function parseImagesBinary(file) {
        const reader = new BinaryReader(await file.arrayBuffer());
        const imageCount = reader.readUint64();
        if (imageCount > Math.floor((reader.view.byteLength - reader.offset) / 73)) {
            throw new Error('Invalid binary image count');
        }

        const poses = [];
        for (let index = 0; index < imageCount; index++) {
            reader.readUint32();
            const qvec = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
            const tvec = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
            reader.readUint32();
            reader.readString();
            const pointCount = reader.readUint64();
            reader.skip(pointCount * 24);
            poses.push(cameraPose(qvec, tvec));
        }
        return poses;
    }

    async function parseImages(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = function (event) {
                const lines = event.target.result.split('\n').filter(line => !line.startsWith('#') && line.trim() !== '');
                const poses = [];
                for (let i = 0; i < lines.length; i += 2) {
                    const data = lines[i].trim().split(/\s+/);
                    const qvec = [parseFloat(data[1]), parseFloat(data[2]), parseFloat(data[3]), parseFloat(data[4])];
                    const tvec = [parseFloat(data[5]), parseFloat(data[6]), parseFloat(data[7])];
                    poses.push(cameraPose(qvec, tvec));
                }
                resolve(poses);
            };
            reader.readAsText(file);
        });
    }

    async function parsePoints3DBinary(file) {
        const reader = new BinaryReader(await file.arrayBuffer());
        const pointCount = reader.readUint64();
        if (pointCount > Math.floor((reader.view.byteLength - reader.offset) / 51)) {
            throw new Error('Invalid binary point count');
        }

        const points = [];
        const colors = [];
        for (let index = 0; index < pointCount; index++) {
            reader.skip(8);
            points.push([reader.readFloat64(), reader.readFloat64(), reader.readFloat64()]);
            colors.push([reader.readUint8() / 255, reader.readUint8() / 255, reader.readUint8() / 255]);
            reader.readFloat64();
            const trackLength = reader.readUint64();
            reader.skip(trackLength * 8);
        }
        return { points, colors };
    }

    async function parsePoints3D(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = function (event) {
                const lines = event.target.result.split('\n').filter(line => !line.startsWith('#') && line.trim() !== '');
                const points = [];
                const colors = [];
                for (const line of lines) {
                    const data = line.trim().split(/\s+/);
                    points.push([parseFloat(data[1]), parseFloat(data[2]), parseFloat(data[3])]);
                    colors.push([parseInt(data[4]) / 255, parseInt(data[5]) / 255, parseInt(data[6]) / 255]);
                }
                resolve({ points, colors });
            };
            reader.readAsText(file);
        });
    }

    function parsePositions(file, format) {
        return format === 'bin' ? parseImagesBinary(file) : parseImages(file);
    }

    function parsePoints(file, format) {
        return format === 'bin' ? parsePoints3DBinary(file) : parsePoints3D(file);
    }

    global.ColmapModelLoader = { BinaryReader, detectFormat, cameraPose, parsePositions, parsePoints };
})(window);
