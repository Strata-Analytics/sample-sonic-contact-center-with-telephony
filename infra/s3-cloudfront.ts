import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { name } from "./utils/name";
import { pathToWebsiteContents } from "./config";
import { crawl } from "./utils/website-upload";
import * as mime from "mime";
import * as path from "path";
import { alb } from "./alb";

const albDomainName = alb.dnsName;
const albOriginId = "backend-origin";

// Bucket S3
export const siteBucket = new aws.s3.BucketV2(name("content-bucket"));
new aws.s3.BucketWebsiteConfigurationV2(name("website-config"), {
  bucket: siteBucket.bucket,
  indexDocument: { suffix: "index.html" },
  errorDocument: { key: "404.html" },
});

const webContentsRoot = path.join(process.cwd(), pathToWebsiteContents);
crawl(webContentsRoot, (fp, rel) => {
  new aws.s3.BucketObject(rel, {
    bucket: siteBucket.bucket,
    key: rel,
    source: new pulumi.asset.FileAsset(fp),
    contentType: mime.getType(fp) || undefined,
  });
});

// Logs y OAI
// const logsBucket = new aws.s3.BucketV2(name("logs-bucket"));
const oai = new aws.cloudfront.OriginAccessIdentity(name("oai"));

// Permiso de lectura desde CloudFront
new aws.s3.BucketPolicy(name("bucket-policy"), {
  bucket: siteBucket.bucket,
  policy: pulumi.all([siteBucket.arn, oai.iamArn]).apply(([arn, iamArn]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: iamArn },
          Action: ["s3:GetObject"],
          Resource: [`${arn}/*`],
        },
      ],
    })
  ),
});

// CloudFront sin dominio personalizado
export const distribution = new aws.cloudfront.Distribution(name("cdn"), {
  enabled: true,
  origins: [
    {
      originId: siteBucket.arn,
      domainName: siteBucket.bucketRegionalDomainName,
      s3OriginConfig: {
        originAccessIdentity: oai.cloudfrontAccessIdentityPath,
      },
    },
    {
      originId: albOriginId,
      domainName: albDomainName,
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: "http-only", // o "http-only" si tu ALB no usa https
        originSslProtocols: ["TLSv1.2"],
      },
    },
  ],
  defaultRootObject: "index.html",
  defaultCacheBehavior: {
    targetOriginId: siteBucket.arn,
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    cachedMethods: ["GET", "HEAD", "OPTIONS"],
    forwardedValues: {
      cookies: { forward: "none" },
      queryString: false,
    },
    minTtl: 0,
    defaultTtl: 0,
    maxTtl: 0,
  },
  customErrorResponses: [
    {
      errorCode: 404,
      responseCode: 404,
      responsePagePath: "/404.html",
    },
  ],
  orderedCacheBehaviors: [
    {
      pathPattern: "/socket",
      targetOriginId: albOriginId,
      viewerProtocolPolicy: "allow-all",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      forwardedValues: {
        queryString: true,
        cookies: { forward: "all" },
        headers: ["*"],
      },
      minTtl: 0,
      defaultTtl: 0,
      maxTtl: 0,
    },
    {
      pathPattern: "/api/*",
      targetOriginId: albOriginId,
      viewerProtocolPolicy: "allow-all",
      allowedMethods: ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
      cachedMethods: ["HEAD", "GET", "OPTIONS"],
      forwardedValues: {
        queryString: true,
        cookies: { forward: "all" },
        headers: ["*"],
      },
      minTtl: 0,
      defaultTtl: 0,
      maxTtl: 0,
    },
  ],
  priceClass: "PriceClass_100",
  restrictions: { geoRestriction: { restrictionType: "none" } },
  viewerCertificate: { cloudfrontDefaultCertificate: true },
});
