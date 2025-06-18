import * as pulumi from "@pulumi/pulumi";
import "./config";
import "./vpc";
import "./security-group";
import "./ec2";
import "./alb";
import "./s3-cloudfront";

import { instance } from "./ec2";
import { alb } from "./alb";
import { distribution } from "./s3-cloudfront";

// Exporta la URL del frontend
export const cloudFrontUrl = pulumi.interpolate`https://${distribution.domainName}`;
export const albDnsName = alb.dnsName;
export const instancePublicIp = instance.publicIp;
