import {Command, Flags} from '@oclif/core'
import {SNSClient, CreateTopicCommand, SubscribeCommand, GetSubscriptionAttributesCommand, PublishCommand} from '@aws-sdk/client-sns'
import {S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand} from '@aws-sdk/client-s3'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import PDFDocument from 'pdfkit'

export default class AwsSnsSetup extends Command {
  static description = 'Create SNS topic, subscribe an email, ensure S3 public bucket, and send a test PDF report'

  static flags = {
    region: Flags.string({description: 'AWS region'}),
    email: Flags.string({description: 'Email to subscribe to SNS', required: true}),
    topicName: Flags.string({description: 'SNS topic name', default: 'autoir-alerts'}),
    bucket: Flags.string({description: 'S3 bucket for public PDFs', default: 'autoir-reports'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AwsSnsSetup)
    const region = flags.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
    const sns = new SNSClient({region})
    const s3 = new S3Client({region})

    // Create or get topic
    const topicArn = (await sns.send(new CreateTopicCommand({Name: flags.topicName}))).TopicArn!
    this.log(`Topic: ${topicArn}`)

    // Subscribe email
    const sub = await sns.send(new SubscribeCommand({TopicArn: topicArn, Protocol: 'email', Endpoint: flags.email}))
    this.log(`Subscription pending confirmation: ${sub.SubscriptionArn || 'pending'}`)

    // Ensure bucket exists
    try { await s3.send(new HeadBucketCommand({Bucket: flags.bucket})) } catch { await s3.send(new CreateBucketCommand({Bucket: flags.bucket})) }
    // Make bucket public via simple policy (read-only)
    const policy = {
      Version: '2012-10-17',
      Statement: [{Sid: 'PublicRead', Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${flags.bucket}/*`]}]
    }
    await s3.send(new PutBucketPolicyCommand({Bucket: flags.bucket, Policy: JSON.stringify(policy)}))

    // Create a test PDF
    const tmp = path.join(os.tmpdir(), 'autoir-test.pdf')
    await this.generateTestPdf(tmp)
    const {PutObjectCommand} = await import('@aws-sdk/client-s3')
    const body = await fs.readFile(tmp)
    await s3.send(new PutObjectCommand({Bucket: flags.bucket, Key: 'test.pdf', Body: body, ContentType: 'application/pdf', ACL: 'public-read'} as any))
    const url = `https://${flags.bucket}.s3.amazonaws.com/test.pdf`
    this.log(`Uploaded test PDF: ${url}`)

    // Send test notification
    await sns.send(new PublishCommand({TopicArn: topicArn, Subject: 'AutoIR Test Report', Message: `Test PDF available at: ${url}`}))
    this.log('Published test notification to SNS')
  }

  private async generateTestPdf(outPath: string): Promise<void> {
    const doc = new PDFDocument({size: 'A4', margin: 50})
    const stream = doc.pipe((await import('node:fs')).createWriteStream(outPath))
    doc.fontSize(22).fillColor('#111111').text('AutoIR Test Report')
    doc.moveDown()
    doc.fontSize(12).fillColor('#333333').text('This is a test PDF generated to verify SNS email and S3 hosting.')
    doc.moveDown()
    const now = new Date().toISOString()
    doc.fillColor('#666666').fontSize(10).text(`Generated at: ${now}`)
    doc.end()
    await new Promise<void>((res, rej) => { stream.on('finish', () => res()); stream.on('error', rej) })
  }
}

