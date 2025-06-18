import * as aws from "@pulumi/aws";
import { name } from "./utils/name";
import { subnet1, subnet2, vpc } from "./vpc";
import { sg } from "./security-group";
import { instance } from "./ec2";

// ALB
export const alb = new aws.lb.LoadBalancer(name("alb"), {
  internal: false,
  loadBalancerType: "application",
  securityGroups: [sg.id],
  subnets: [subnet1.id, subnet2.id],
});

// Target Group
export const targetGroup = new aws.lb.TargetGroup(name("tg"), {
  port: 3001,
  protocol: "HTTP",
  targetType: "instance",
  vpcId: vpc.id,
  healthCheck: {
    path: "/",
    protocol: "HTTP",
    matcher: "200",
    interval: 30,
  },
});

// Listener
export const listener = new aws.lb.Listener(name("listener"), {
  loadBalancerArn: alb.arn,
  port: 80,
  defaultActions: [
    {
      type: "forward",
      targetGroupArn: targetGroup.arn,
    },
  ],
});

// Attach Instance to Target Group
new aws.lb.TargetGroupAttachment(name("tg-attach"), {
  targetGroupArn: targetGroup.arn,
  targetId: instance.id,
  port: 3001,
});
