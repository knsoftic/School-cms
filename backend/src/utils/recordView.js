'use strict';

/**
 * A person's record as a caller who may read it but not manage it is shown.
 *
 * `teachers.view`, `staff.view` and `parents.view` reach roles that need the directory — a Librarian
 * lending to teachers and staff, a Teacher contacting a parent — and the three modules returned the
 * whole row to them: every teacher's and staff member's salary, date of birth, address and the office's
 * notes to the Librarian, and every parent's national ID and address to every Teacher. Found by an audit
 * of what each low-privilege role could read, after the same row leaked through the teacher timetable.
 *
 * The rule is the catalogue's own split: whoever holds the module's `.manage` key keeps the HR record;
 * everyone else gets the row without the columns each module names. Columns are removed rather than
 * listed in, so a directory field added later is not silently withheld — the ones named here are the
 * record-keeping the directory never needed.
 */

/**
 * @param {import('express').Request} req
 * @param {string} key  the module's manage permission
 * @returns {Promise<boolean>}
 */
async function canManage(req, key) {
  if (!req || typeof req.getPermissions !== 'function') return false;
  return (await req.getPermissions()).has(key);
}

/**
 * The row's values without `fields`.
 *
 * @param {object} row     a model instance or plain object
 * @param {string[]} fields
 * @returns {object}
 */
function withoutFields(row, fields) {
  const json = row && typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  for (const field of fields) delete json[field];
  return json;
}

module.exports = { canManage, withoutFields };
