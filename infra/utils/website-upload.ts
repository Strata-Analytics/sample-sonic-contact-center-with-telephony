import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import * as mime from "mime";

export function crawl(dir: string, fn: (file: string, rel: string) => void, rel = "") {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const r = rel ? path.posix.join(rel, item) : item;
    if (fs.statSync(full).isDirectory()) crawl(full, fn, r);
    else fn(full, r);
  }
}