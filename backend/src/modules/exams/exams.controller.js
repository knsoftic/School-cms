'use strict';

const service = require('./exams.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { REPORT_FORMATS } = require('../../config/constants');

/* ── §19.1 the Grade System ── */

async function listGrades(req, res) {
  const pagination = getPagination(req);
  const result = await service.listGrades(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function createGrade(req, res) {
  const grade = await service.createGrade(req, req.body);
  describeActivity(req, {
    entityId: grade.id,
    description: `Added grade band ${grade.name} (${grade.min_percentage}–${grade.max_percentage}%) to scale "${grade.scale_name}"`,
    metadata: { school_id: grade.school_id, scale_name: grade.scale_name, name: grade.name },
  });
  return ApiResponse.created(res, { grade }, { message: 'Grade band created' });
}

async function updateGrade(req, res) {
  const grade = await service.updateGrade(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: grade.id,
    description: `Updated grade band ${grade.name}`,
    metadata: { school_id: grade.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { grade }, { message: 'Grade band updated' });
}

/* ── §19.1 the examination ── */

async function listExams(req, res) {
  const pagination = getPagination(req);
  const result = await service.listExams(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showExam(req, res) {
  const exam = await service.findExam(req, req.params.id, undefined, { detail: true });
  return ApiResponse.ok(res, { exam });
}

async function createExam(req, res) {
  const exam = await service.createExam(req, req.body);
  describeActivity(req, {
    entityId: exam.id,
    description: `Created ${exam.exam_type} exam "${exam.name}"`,
    metadata: { school_id: exam.school_id, class_id: exam.class_id, section_id: exam.section_id, grade_scale: exam.grade_scale },
  });
  return ApiResponse.created(res, { exam }, { message: 'Exam created' });
}

async function updateExam(req, res) {
  const exam = await service.updateExam(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: exam.id,
    description: `Updated exam "${exam.name}"`,
    metadata: { school_id: exam.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { exam }, { message: 'Exam updated' });
}

/* ── §19.1 Subjects, Marks, Passing Marks ── */

async function listExamSubjects(req, res) {
  const { rows } = await service.listExamSubjects(req, req.params.id, req.query);
  return ApiResponse.ok(res, { subjects: rows });
}

async function addExamSubject(req, res) {
  const { exam, row } = await service.addExamSubject(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Added a paper worth ${row.full_marks} marks to exam "${exam.name}"`,
    metadata: { school_id: exam.school_id, exam_id: exam.id, subject_id: row.subject_id, full_marks: row.full_marks },
  });
  return ApiResponse.created(res, { subject: row }, { message: 'Exam subject added' });
}

async function updateExamSubject(req, res) {
  const { exam, row } = await service.updateExamSubject(req, req.params.id, req.params.examSubjectId, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Updated a paper on exam "${exam.name}"`,
    metadata: { school_id: exam.school_id, exam_id: exam.id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { subject: row }, { message: 'Exam subject updated' });
}

/* ── §19.2 Marks ── */

async function listMarks(req, res) {
  const pagination = getPagination(req);
  const result = await service.listMarks(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function enterMarks(req, res) {
  const { exam, examSubject, rows } = await service.enterMarks(req, req.body);
  /*
   * The batch is the event for the activity trail. Unlike a fee, a mark is not money and a per-row
   * audit of a whole class's paper would duplicate `entered_by` at two hundred times the volume —
   * the reasoning attendance gives for the same shape.
   */
  describeActivity(req, {
    entityId: examSubject.id,
    description: `Entered marks for ${rows.length} student(s) on exam "${exam.name}"`,
    metadata: { school_id: exam.school_id, exam_id: exam.id, exam_subject_id: examSubject.id, count: rows.length },
  });
  return ApiResponse.ok(res, { marks: rows }, { message: 'Marks recorded' });
}

async function submitMarks(req, res) {
  const { exam, examSubject, ...summary } = await service.submitMarks(req, req.body);
  describeActivity(req, {
    entityId: examSubject.id,
    description: `Submitted marks for a paper on exam "${exam.name}"`,
    metadata: {
      school_id: exam.school_id,
      exam_id: exam.id,
      exam_subject_id: examSubject.id,
      papers_counted: summary.papersCounted,
      papers_outstanding: summary.papersOutstanding,
    },
  });
  /* FR-EXAM-003 runs on submission, so the response says what it calculated. */
  return ApiResponse.ok(res, { calculation: summary }, { message: 'Marks submitted' });
}

/* ── §19.3 Results ── */

async function generateResults(req, res) {
  const { exam, summary } = await service.generateResults(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: exam.id,
    description: `Generated results for exam "${exam.name}" — ${summary.ranked} student(s) ranked`,
    metadata: { school_id: exam.school_id, exam_id: exam.id, ...summary },
  });
  return ApiResponse.ok(res, { summary }, { message: 'Results generated' });
}

async function publishResults(req, res) {
  const { exam, published } = await service.publishResults(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: exam.id,
    description: `Published ${published} result(s) for exam "${exam.name}"`,
    metadata: { school_id: exam.school_id, exam_id: exam.id, published },
  });
  return ApiResponse.ok(res, { exam, published }, { message: 'Results published' });
}

async function listResults(req, res) {
  const pagination = getPagination(req);
  const result = await service.listResults(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function classResult(req, res) {
  const exam = await service.findExam(req, req.params.id);
  const pagination = getPagination(req);
  const result = await service.listResults(
    req,
    { ...req.query, exam_id: exam.id, school_id: exam.school_id },
    pagination
  );
  return ApiResponse.paginated(res, result, pagination);
}

/** FR-EXAM-004 "Result Card" / "Student Result", and the half of FR-EXAM-005 this module delivers. */
const PDF_MIME = 'application/pdf';

async function showResult(req, res) {
  const result = await service.findResult(req, req.params.id);
  const card = await service.resultCard(req, result);

  /*
   * FR-EXAM-005. Rendered from the same `card` the JSON branch returns, so the printed result and
   * the one on screen cannot disagree — and streamed as a Buffer, so `results.result_card_path`
   * stays null and no storage or file-serving story is needed. §22 established both.
   *
   * Recorded in the activity trail, and the JSON read is not: a result card that leaves the building
   * as a file is a different event from one a client rendered, and FR-EXAM-005 is a requirement of
   * its own. That is §22's rule, applied here for the same reason.
   */
  if (req.query.format === REPORT_FORMATS.PDF) {
    const buffer = await service.resultCardPdf(card);
    describeActivity(req, {
      entityId: result.id,
      description: `Exported a result card as PDF`,
      metadata: { result_id: result.id, exam_id: result.exam_id, bytes: buffer.length },
    });
    res.setHeader('Content-Type', PDF_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="result-card-${result.id}-${new Date().toISOString().slice(0, 10)}.pdf"`
    );
    return res.status(200).send(buffer);
  }

  return ApiResponse.ok(res, { result, card });
}

async function myResults(req, res) {
  const pagination = getPagination(req);
  const result = await service.myResults(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

module.exports = {
  listGrades,
  createGrade,
  updateGrade,
  listExams,
  showExam,
  createExam,
  updateExam,
  listExamSubjects,
  addExamSubject,
  updateExamSubject,
  listMarks,
  enterMarks,
  submitMarks,
  generateResults,
  publishResults,
  listResults,
  classResult,
  showResult,
  myResults,
  PDF_MIME,
};
