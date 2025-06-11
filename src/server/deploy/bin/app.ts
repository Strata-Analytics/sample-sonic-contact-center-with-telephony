import * as cdk from "aws-cdk-lib";
// import { ServerStack } from "../lib/server-stack";
import { ServerStackNoDomain } from "../lib/server-stack-no-domain";

const account = process.env.CDK_DEFAULT_ACCOUNT!;
const region = process.env.CDK_DEFAULT_REGION || "us-east-1";

const app = new cdk.App();

new ServerStackNoDomain(app, "ServerStack", {
  env: {
    account,
    region,
  },
  description: "Server deployment with IP whitelisting",
});
