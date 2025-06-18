import * as aws from "@pulumi/aws";
import { name } from "./utils/name";
import { vpc } from "./vpc";
import { myIp } from "./config";

export const sg = new aws.ec2.SecurityGroup(name("sg"), {
  name: name("sg"),
  vpcId: vpc.id,
  description: "Allow SSH, HTTP, HTTPS and app port",
  ingress: [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [myIp] }, // SSH solo desde tu IP
    { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }, // HTTP público para ALB
    { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }, // HTTPS público (si usás)
  ],
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
});
// app puerto 3001 solo desde ALB (mismo SG)
new aws.ec2.SecurityGroupRule(name("sg-rule-3001"), {
  type: "ingress",
  fromPort: 3001,
  toPort: 3001,
  protocol: "tcp",
  securityGroupId: sg.id,
  sourceSecurityGroupId: sg.id,
});