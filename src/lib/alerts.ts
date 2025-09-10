import {SNSClient, PublishCommand} from '@aws-sdk/client-sns'
import {S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, BucketLocationConstraint} from '@aws-sdk/client-s3'
import os from 'node:os'
import path from 'node:path'
import {promises as fs} from 'node:fs'
import PDFDocument from 'pdfkit'

export type IncidentReportInput = {
  id: string
  title: string
  severity: 'info'|'low'|'medium'|'high'|'critical'
  confidence: number
  summary: string
  aggregates: Array<{group: string; count: number}>
  samples: Array<{timestamp: string; group: string; stream: string; message: string}>
}

export async function ensureBucketPublic(s3: S3Client, bucket: string, region?: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({Bucket: bucket}))
  } catch {
    const loc: BucketLocationConstraint | undefined = (region && region !== 'us-east-1') ? (region as BucketLocationConstraint) : undefined
    await s3.send(new CreateBucketCommand({Bucket: bucket, ...(loc ? {CreateBucketConfiguration: {LocationConstraint: loc}} : {})}))
  }
}

export async function generateIncidentPdf(input: IncidentReportInput, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), {recursive: true})
  const doc = new PDFDocument({size: 'A4', margin: 50})
  const stream = doc.pipe((await import('node:fs')).createWriteStream(outPath))

  // Header
  doc.fillColor('#111111').fontSize(22).text('Incident Report', {align: 'left'})
  doc.moveDown(0.3)
  doc.fillColor('#666666').fontSize(10).text(new Date().toLocaleString(), {align: 'left'})
  doc.moveDown(1)

  // Title + severity
  const sevColor = input.severity === 'critical' ? '#b30000' : input.severity === 'high' ? '#cc5500' : input.severity === 'medium' ? '#cc9900' : input.severity === 'low' ? '#2a9d8f' : '#6c757d'
  doc.roundedRect(50, 110, 495, 1, 0).fill('#e9ecef').fillColor('#000000')
  doc.moveDown(0.5)
  doc.fillColor('#000000').fontSize(16).text(input.title, {continued: true})
  doc.fillColor(sevColor).fontSize(12).text(`   [${input.severity.toUpperCase()} • ${Math.round(input.confidence*100)}%]`)
  doc.moveDown(0.5)
  doc.fillColor('#333333').fontSize(12).text(input.summary || 'No summary provided.')
  doc.moveDown(1)

  // Aggregates
  doc.fillColor('#111111').fontSize(14).text('Top Groups')
  doc.moveDown(0.2)
  doc.fillColor('#444444').fontSize(11)
  for (const a of input.aggregates) {
    doc.text(`• ${a.group}: ${a.count}`)
  }
  if (input.aggregates.length === 0) doc.text('No aggregates available')
  doc.moveDown(1)

  // Samples
  doc.fillColor('#111111').fontSize(14).text('Sample Logs')
  doc.moveDown(0.2)
  doc.fillColor('#222222').fontSize(10)
  for (const s of input.samples) {
    doc.text(`[${s.timestamp}] ${s.group} ${s.stream}`, {continued: false})
    doc.fillColor('#555555').text(s.message)
    doc.moveDown(0.5)
    doc.fillColor('#222222')
  }
  if (input.samples.length === 0) doc.text('No sample logs available')

  // Footer
  doc.moveDown(1)
  doc.fillColor('#888888').fontSize(9).text(`Report ID: ${input.id}`, {align: 'right'})

  doc.end()
  await new Promise<void>((res, rej) => { stream.on('finish', () => res()); stream.on('error', rej) })
}

export async function uploadPublicPdf(s3: S3Client, bucket: string, key: string, filePath: string): Promise<string> {
  const body = await fs.readFile(filePath)
  await s3.send(new PutObjectCommand({Bucket: bucket, Key: key, Body: body, ContentType: 'application/pdf', ACL: 'public-read'} as any))
  const url = `https://${bucket}.s3.amazonaws.com/${encodeURIComponent(key)}`
  return url
}

export async function publishSns(sns: SNSClient, topicArn: string, subject: string, message: string): Promise<void> {
  await sns.send(new PublishCommand({TopicArn: topicArn, Subject: subject.slice(0, 100), Message: message}))
}

export async function generateAndSendIncidentReport(opts: {
  region?: string
  bucket: string
  topicArn: string
  incident: IncidentReportInput
}): Promise<{url: string}> {
  const s3 = new S3Client({region: opts.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION})
  const sns = new SNSClient({region: opts.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION})
  await ensureBucketPublic(s3, opts.bucket, opts.region)

  const tmp = path.join(os.tmpdir(), `incident-${opts.incident.id}.pdf`)
  await generateIncidentPdf(opts.incident, tmp)
  const key = `reports/${opts.incident.id}.pdf`
  const url = await uploadPublicPdf(s3, opts.bucket, key, tmp)

  const subject = `[${opts.incident.severity.toUpperCase()}][${Math.round(opts.incident.confidence*100)}%] ${opts.incident.title}`
  const body = `${opts.incident.summary || ''}\n\nReport: ${url}`
  await publishSns(sns, opts.topicArn, subject, body)
  return {url}
}

