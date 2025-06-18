import * as aws from "@pulumi/aws";
import { name } from "./utils/name";

export const vpc = new aws.ec2.Vpc(name("vpc"), {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
});

// Subnets
export const subnet1 = new aws.ec2.Subnet(name("subnet-1"), {
  vpcId: vpc.id,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1a",
  mapPublicIpOnLaunch: true,
});

export const subnet2 = new aws.ec2.Subnet(name("subnet-2"), {
  vpcId: vpc.id,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-east-1b",
  mapPublicIpOnLaunch: true,
});

// Internet Gateway
export const igw = new aws.ec2.InternetGateway(name("igw"), {
  vpcId: vpc.id,
});

// Route Table
export const routeTable = new aws.ec2.RouteTable(name("rt"), {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
});

// Route Table Associations
new aws.ec2.RouteTableAssociation(name("rta-subnet-1"), {
  subnetId: subnet1.id,
  routeTableId: routeTable.id,
});

new aws.ec2.RouteTableAssociation(name("rta-subnet-2"), {
  subnetId: subnet2.id,
  routeTableId: routeTable.id,
});