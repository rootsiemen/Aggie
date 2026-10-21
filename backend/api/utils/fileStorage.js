'use strict';

// Incident comment attachment bytes live in MongoDB (the `mediaassets` collection), so they
// travel with the database — no request handler writes to the local filesystem anymore.
// Storage keys are content-addressed (`incidents/attachments/{sha256}.{ext}`), so uploading
// the same file twice stores its bytes once. Signatures are unchanged from the old disk
// version (`saveFile` returns the storage reference the controller stores on the attachment;
// `deleteFile` removes it), only what they point at changed.

const crypto = require('crypto');
const path = require('path');

const MediaAsset = require('../../models/mediaAsset');
const Group = require('../../models/group');

const ATTACHMENT_KEY_PREFIX = 'incidents/attachments';

// Allowed types are enforced by multer + validateAttachments before this is called; this only
// picks a sane extension for the key.
const EXTENSION_BY_MIME_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

function extensionFor(mimeType, originalname) {
  if (mimeType && EXTENSION_BY_MIME_TYPE[mimeType]) {
    return EXTENSION_BY_MIME_TYPE[mimeType];
  }
  const ext = path
    .extname(String(originalname || ''))
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  return ext || 'bin';
}

function keyFor(fileBuffer, originalname, mimeType) {
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  return `${ATTACHMENT_KEY_PREFIX}/${hash}.${extensionFor(mimeType, originalname)}`;
}

async function saveFile(fileBuffer, originalname, mimeType) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error('Failed saving file: empty or invalid buffer');
  }
  const key = keyFor(fileBuffer, originalname, mimeType);
  // Upsert: the same bytes uploaded twice (or to two comments) are stored once.
  await MediaAsset.updateOne(
    { key },
    {
      $set: {
        data: fileBuffer,
        contentType: mimeType || 'application/octet-stream',
        byteSize: fileBuffer.length,
        kind: 'incident-attachment',
      },
    },
    { upsert: true }
  );
  return key;
}

async function deleteFile(storageKey) {
  if (!storageKey) return;
  try {
    // Keys are content-addressed and may be shared by several comments — only drop the bytes
    // when no group still references this key.
    const stillReferenced = await Group.findOne({
      'comments.attachments.storageKey': storageKey,
    })
      .select('_id')
      .lean();
    if (!stillReferenced) {
      await MediaAsset.deleteOne({ key: storageKey });
    }
  } catch (err) {
    console.error(`debugging - Failed deleting file: ${storageKey}, `, err);
    throw new Error(`Failed deleting file: ${storageKey}`, err);
  }
}

module.exports = {
  saveFile,
  deleteFile,
};
