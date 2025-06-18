import * as pulumi from "@pulumi/pulumi";

export const config = new pulumi.Config();
export const myIp = config.require("myIp");
export const keyPairName = config.require("keyPairName");
export const pathToWebsiteContents = config.require("pathToWebsiteContents");