/**
 * Chunk worker: terrain generation and greedy meshing off the main thread.
 *
 * Both jobs are pure functions of their input, which is what makes them safe to
 * fan out across a pool. Every array crossing the boundary is transferred, not
 * copied, so a 16-cube section costs a pointer hand-off rather than 17 kB of
 * structured cloning per message.
 *
 * Loaded as `new Worker(url, { type: 'module' })`.
 */

import { generateChunk } from '../src/WorldGen.js';
import { meshSection } from '../src/Mesher.js';

self.onmessage = (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'generate': {
      const result = generateChunk(msg.cx, msg.cz, msg.seed);
      self.postMessage({
        type: 'generated',
        id: msg.id,
        cx: msg.cx,
        cz: msg.cz,
        blocks: result.blocks,
        biome: result.biome,
      }, [result.blocks.buffer]);
      break;
    }

    case 'mesh': {
      const { opaque, water } = meshSection(msg.blocks, msg.light);

      // Collect every produced buffer for transfer. Handing the scratch input
      // buffers back too lets the main thread recycle them instead of
      // allocating a fresh pair per section.
      const transfer = [msg.blocks.buffer, msg.light.buffer];
      if (opaque !== null) {
        transfer.push(
          opaque.positions.buffer, opaque.normals.buffer,
          opaque.uvs.buffer, opaque.colors.buffer, opaque.indices.buffer,
        );
      }
      if (water !== null) {
        transfer.push(
          water.positions.buffer, water.normals.buffer,
          water.uvs.buffer, water.colors.buffer, water.indices.buffer,
        );
      }

      self.postMessage({
        type: 'meshed',
        id: msg.id,
        cx: msg.cx,
        cz: msg.cz,
        section: msg.section,
        opaque,
        water,
        recycleBlocks: msg.blocks,
        recycleLight: msg.light,
      }, transfer);
      break;
    }

    default:
      self.postMessage({ type: 'error', id: msg.id, message: 'mensagem desconhecida: ' + msg.type });
  }
};
