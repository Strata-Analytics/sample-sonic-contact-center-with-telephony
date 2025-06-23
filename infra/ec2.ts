import * as aws from "@pulumi/aws";
import { name } from "./utils/name";
import { subnet1 } from "./vpc";
import { sg } from "./security-group";
import { keyPairName } from "./config";

const userData = `#!/bin/bash
yum update -y
# Instalar Node.js 16.x y git
curl -fsSL https://rpm.nodesource.com/setup_16.x | bash -
yum install -y nodejs git

# Crear claves SSH sin passphrase para GitHub
ssh-keygen -t rsa -b 4096 -C "ec2-user@teco-bot-poc" -f /home/ec2-user/.ssh/id_rsa -N ""

# Cambiar permisos
chown ec2-user:ec2-user /home/ec2-user/.ssh/id_rsa*
chmod 600 /home/ec2-user/.ssh/id_rsa`;
// agregar a userdata instalar pm2
// instalar node v22/lts

// copiar llave publica y llevarla a github
// git pull & npm i & pm2 start 
// cambiar ami ec2 con el objetico de instalar node v22 lts

export const instance = new aws.ec2.Instance(name("instance"), {
  ami: aws.ec2
    .getAmi({
      filters: [{ name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] }],
      owners: ["amazon"],
      mostRecent: true,
    })
    .then((ami) => ami.id),
  instanceType: "t3.small",
  subnetId: subnet1.id,
  vpcSecurityGroupIds: [sg.id],
  keyName: keyPairName,
  associatePublicIpAddress: true,
  tags: { Name: name("instance") },
  userData,
});