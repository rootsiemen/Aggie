'use strict';

/**
 * One-time backfill: move legacy incident comment attachment bytes from disk
 * (`public/uploads/`) into the `mediaassets` Mongo collection, so attachments travel with
 * the database. Modeled on `backend/scripts/backfillMediaToMongo.js`.
 *
 * REFERENCE-AWARE — migrates only the files a comment actually references (`serverPath` on
 * the attachment subdocument). Files on disk with no matching record are orphans: they are
 * counted and reported, never ingested, never deleted ("orphaned files are left alone").
 *
 * Idempotent: upserts the MediaAsset per content-addressed key, and sets `storageKey` /
 * `$unset`s `serverPath` per attachment. Re-running after a partial run only picks up
 * attachments that still have a `serverPath`.
 *
 * DRY RUN BY DEFAULT. Pass `--apply` to actually write.
 * Usage: node backend/scripts/backfillAttachmentsToMongo.js [--apply]
 */

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const database = require('../database'); // connects on require
const Group = require('../models/group');
const MediaAsset = require('../models/mediaAsset');

const DRY_RUN = !process.argv.includes('--apply');
// Same resolution the old disk store used (`backend/api/utils/fileStorage.js` before this fix).
const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, '../../public/uploads');

const EXTENSION_BY_MIME_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

function extensionFor(mimeType, serverPath) {
  if (mimeType && EXTENSION_BY_MIME_TYPE[mimeType]) {
    return EXTENSION_BY_MIME_TYPE[mimeType];
  }
  const ext = path
    .extname(String(serverPath || ''))
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  return ext || 'bin';
}

function keyFor(buffer, mimeType, serverPath) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return `incidents/attachments/${hash}.${extensionFor(mimeType, serverPath)}`;
}

// Every comment attachment, flattened: [{ groupId, commentId, attachmentId, attachment }].
async function collectAttachments() {
  const rows = await Group.aggregate([
    { $unwind: '$comments' },
    { $unwind: '$comments.attachments' },
    {
      $project: {
        _id: 0,
        groupId: '$_id',
        commentId: '$comments._id',
        attachmentId: '$comments.attachments._id',
        attachment: '$comments.attachments',
      },
    },
  ]);
  return rows;
}

async function migrateAttachment({ groupId, commentId, attachmentId, attachment }) {
  if (!attachment.serverPath) return { status: 'already-migrated' };

  let buffer;
  try {
    buffer = await fs.readFile(attachment.serverPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'dangling' };
    throw error;
  }

  const key = keyFor(buffer, attachment.mimeType, attachment.serverPath);

  if (!DRY_RUN) {
    await MediaAsset.updateOne(
      { key },
      {
        $set: {
          data: buffer,
          contentType: attachment.mimeType || 'application/octet-stream',
          byteSize: buffer.length,
          kind: 'incident-attachment',
        },
      },
      { upsert: true }
    );

    await Group.updateOne(
      { _id: groupId },
      {
        $set: {
          'comments.$[c].attachments.$[a].storageKey': key,
          'comments.$[c].attachments.$[a].path': `/incidents/uploads/${path.basename(key)}`,
        },
        $unset: { 'comments.$[c].attachments.$[a].serverPath': 1 },
      },
      { arrayFilters: [{ 'c._id': commentId }, { 'a._id': attachmentId }] }
    );
  }

  return { status: 'migrated', bytes: buffer.length, key };
}

async function main() {
  const rows = await collectAttachments();
  console.log(
    `[backfillAttachmentsToMongo]${DRY_RUN ? ' (dry run)' : ''} ${rows.length} comment attachments.`
  );

  const counts = { migrated: 0, dangling: 0, alreadyMigrated: 0 };
  let migratedBytes = 0;
  const danglingPaths = [];
  const referencedBasenames = new Set();

  for (const row of rows) {
    if (row.attachment.serverPath) {
      referencedBasenames.add(path.basename(row.attachment.serverPath));
    }
    const result = await migrateAttachment(row);
    if (result.status === 'migrated') {
      counts.migrated += 1;
      migratedBytes += result.bytes;
    } else if (result.status === 'dangling') {
      counts.dangling += 1;
      danglingPaths.push(row.attachment.serverPath);
    } else {
      counts.alreadyMigrated += 1;
    }
  }

  // Orphaned files: on disk but referenced by no attachment record — counted and reported,
  // never ingested, never deleted.
  let orphaned = 0;
  let orphanedBytes = 0;
  let entries;
  try {
    entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (referencedBasenames.has(entry.name)) continue;
    orphaned += 1;
    try {
      const { size } = await fs.stat(path.join(UPLOAD_DIR, entry.name));
      orphanedBytes += size;
    } catch (_) {
      /* file vanished mid-walk — ignore */
    }
  }

  const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  console.log(
    `[backfillAttachmentsToMongo] Done${DRY_RUN ? ' (dry run — no writes)' : ''}. ` +
      `migrated=${counts.migrated} (${mib(migratedBytes)} MiB), ` +
      `already-migrated=${counts.alreadyMigrated}, ` +
      `dangling=${counts.dangling} (referenced but missing on disk), ` +
      `orphaned=${orphaned} (${mib(orphanedBytes)} MiB, on disk but unreferenced — NOT migrated).`
  );
  if (danglingPaths.length > 0) {
    console.log(
      '[backfillAttachmentsToMongo] Dangling paths:',
      danglingPaths.slice(0, 20).join(', ') + (danglingPaths.length > 20 ? ' …' : '')
    );
  }
  if (DRY_RUN) {
    console.log('[backfillAttachmentsToMongo] Re-run with --apply to perform the migration.');
  }
}

database.mongoose.connection.once('open', async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error('[backfillAttachmentsToMongo] Aborted:', error);
    process.exit(1);
  }
});
