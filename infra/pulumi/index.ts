import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';

const config = new pulumi.Config();
const domainName = config.require('domainName');
const hostedZoneId = config.get('hostedZoneId');
const suppliedCertificateArn = config.get('certificateArn');
const dbPassword = config.requireSecret('dbPassword');
const apiToken = config.requireSecret('apiToken');
if (!suppliedCertificateArn && !hostedZoneId) {
  throw new Error('Set hostedZoneId for Route 53 validation, or supply an issued certificateArn');
}
// Validate the rollback override before registering any resources.
const imageOverride = config.get('imageUri');
if (imageOverride && !/@sha256:[a-f0-9]{64}$/.test(imageOverride)) {
  throw new Error('imageUri must reference an immutable sha256 image digest');
}

// Route 53 can manage validation and API DNS in this deployment. An existing
// certificate also supports a hostname whose DNS is hosted elsewhere.
let certificateArn: pulumi.Input<string>;
if (suppliedCertificateArn) {
  certificateArn = suppliedCertificateArn;
} else {
  const certificate = new aws.acm.Certificate('scos-certificate', {
    domainName,
    validationMethod: 'DNS'
  });
  const validation = new aws.route53.Record('scos-certificate-validation', {
    zoneId: hostedZoneId!,
    name: certificate.domainValidationOptions.apply(options => options[0].resourceRecordName),
    type: certificate.domainValidationOptions.apply(options => options[0].resourceRecordType),
    records: [certificate.domainValidationOptions.apply(options => options[0].resourceRecordValue)],
    ttl: 60
  });
  certificateArn = new aws.acm.CertificateValidation('scos-validated-certificate', {
    certificateArn: certificate.arn,
    validationRecordFqdns: [validation.fqdn]
  }).certificateArn;
}

// Build and publish before ECS starts, including on the first deployment.
const repository = new aws.ecr.Repository('scos-images', {
  imageScanningConfiguration: { scanOnPush: true },
  forceDelete: false
});
const image = new awsx.ecr.Image('scos-image', {
  repositoryUrl: repository.repositoryUrl,
  context: '../..',
  platform: 'linux/amd64',
  builderVersion: awsx.ecr.BuilderVersion.BuilderBuildKit
});
// An explicit digest can select a previously published image for rollback.
const imageUri = imageOverride ?? image.imageUri;

// Public tasks use an internet gateway for outbound access. Their security group
// only accepts application traffic from the ALB; PostgreSQL stays private.
const vpc = new awsx.ec2.Vpc('scos-vpc', {
  numberOfAvailabilityZones: 2,
  natGateways: {
    strategy: awsx.ec2.NatGatewayStrategy.None
  }
});

// Application logs.
const logGroup = new aws.cloudwatch.LogGroup('/ecs/screencloud-oms', {
  name: '/ecs/screencloud-oms',
  retentionInDays: 30
});

// PostgreSQL accepts connections only from the application security group.
const dbSubnetGroup = new aws.rds.SubnetGroup('scos-db-subnet-group', {
  subnetIds: vpc.privateSubnetIds
});

const ecsSecurityGroup = new aws.ec2.SecurityGroup('scos-ecs-sg', {
  vpcId: vpc.vpcId,
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }]
});

const dbSecurityGroup = new aws.ec2.SecurityGroup('scos-db-sg', {
  vpcId: vpc.vpcId,
  description: 'Allow inbound PostgreSQL traffic from ECS Fargate tasks',
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      securityGroups: [ecsSecurityGroup.id]
    }
  ],
  egress: [
    {
      protocol: '-1',
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ['0.0.0.0/0']
    }
  ]
});

const rdsInstance = new aws.rds.Instance('scos-postgres', {
  engine: 'postgres',
  engineVersion: '16',
  instanceClass: 'db.t4g.micro',
  allocatedStorage: 20,
  dbName: 'screencloud_oms',
  username: 'postgres',
  password: dbPassword,
  dbSubnetGroupName: dbSubnetGroup.name,
  vpcSecurityGroupIds: [dbSecurityGroup.id],
  storageEncrypted: true,
  publiclyAccessible: false,
  backupRetentionPeriod: 7,
  deletionProtection: config.getBoolean('databaseDeletionProtection') ?? true,
  multiAz: config.getBoolean('databaseMultiAz') ?? false,
  finalSnapshotIdentifier: `scos-${pulumi.getStack()}-final`,
  skipFinalSnapshot: false
});

// HTTPS ingress.
const albSecurityGroup = new aws.ec2.SecurityGroup('scos-alb-sg', {
  vpcId: vpc.vpcId,
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrBlocks: ['0.0.0.0/0']
    }
  ],
  egress: [
    {
      protocol: '-1',
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ['0.0.0.0/0']
    }
  ]
});

const albToApp = new aws.ec2.SecurityGroupRule('scos-alb-to-app', {
  type: 'ingress',
  securityGroupId: ecsSecurityGroup.id,
  sourceSecurityGroupId: albSecurityGroup.id,
  protocol: 'tcp',
  fromPort: 3000,
  toPort: 3000
});

const alb = new aws.lb.LoadBalancer('scos-alb', {
  internal: false,
  securityGroups: [albSecurityGroup.id],
  subnets: vpc.publicSubnetIds
});

if (hostedZoneId) {
  new aws.route53.Record('scos-api-dns', {
    zoneId: hostedZoneId,
    name: domainName,
    type: 'A',
    aliases: [{ name: alb.dnsName, zoneId: alb.zoneId, evaluateTargetHealth: true }]
  });
}

const targetGroup = new aws.lb.TargetGroup('scos-tg', {
  port: 3000,
  protocol: 'HTTP',
  targetType: 'ip',
  vpcId: vpc.vpcId,
  healthCheck: {
    path: '/ready',
    protocol: 'HTTP',
    interval: 15,
    timeout: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 3
  }
});

const listener = new aws.lb.Listener('scos-listener', {
  loadBalancerArn: alb.arn,
  port: 443,
  protocol: 'HTTPS',
  certificateArn,
  sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
  defaultActions: [
    {
      type: 'forward',
      targetGroupArn: targetGroup.arn
    }
  ]
});

// Application runtime.
const ecsCluster = new aws.ecs.Cluster('scos-cluster', {
  name: 'screencloud-oms-cluster'
});

const ecsTaskExecutionRole = new aws.iam.Role('scos-task-exec-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: {
          Service: 'ecs-tasks.amazonaws.com'
        }
      }
    ]
  })
});

const executionPolicy = new aws.iam.RolePolicyAttachment('scos-task-exec-policy', {
  role: ecsTaskExecutionRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
});

const databaseSecret = new aws.secretsmanager.Secret('scos-database-url');
const databaseSecretVersion = new aws.secretsmanager.SecretVersion('scos-database-url-value', {
  secretId: databaseSecret.id,
  secretString: pulumi
    .all([rdsInstance.endpoint, dbPassword])
    .apply(
      ([endpoint, password]) =>
        `postgresql://postgres:${encodeURIComponent(password)}@${endpoint}/screencloud_oms?sslmode=verify-full`
    )
});
const tokenSecret = new aws.secretsmanager.Secret('scos-api-token');
const tokenSecretVersion = new aws.secretsmanager.SecretVersion('scos-api-token-value', {
  secretId: tokenSecret.id,
  secretString: apiToken
});
const secretPolicy = new aws.iam.RolePolicy('scos-read-secrets', {
  role: ecsTaskExecutionRole.name,
  policy: pulumi
    .all([databaseSecret.arn, tokenSecret.arn])
    .apply((resources) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: resources }
        ]
      })
    )
});

const taskDefinition = new aws.ecs.TaskDefinition('scos-task-def', {
  family: 'screencloud-oms',
  cpu: '256',
  memory: '512',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'X86_64' },
  executionRoleArn: ecsTaskExecutionRole.arn,
  containerDefinitions: pulumi
    .all([logGroup.name, databaseSecret.arn, tokenSecret.arn, imageUri])
    .apply(([logGroupName, databaseArn, tokenArn, containerImage]) =>
      JSON.stringify([
        {
          name: 'screencloud-oms',
          image: containerImage,
          essential: true,
          portMappings: [
            {
              containerPort: 3000,
              hostPort: 3000
            }
          ],
          environment: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'PORT', value: '3000' },
            { name: 'HOST', value: '0.0.0.0' }
          ],
          secrets: [
            { name: 'DATABASE_URL', valueFrom: databaseArn },
            { name: 'API_TOKEN', valueFrom: tokenArn }
          ],
          healthCheck: {
            command: ['CMD-SHELL', 'wget --quiet --spider http://127.0.0.1:3000/ready || exit 1'],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 60
          },
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logGroupName,
              'awslogs-region': aws.config.region || 'us-east-1',
              'awslogs-stream-prefix': 'ecs'
            }
          }
        }
      ])
    )
});

const fargateService = new aws.ecs.Service(
  'scos-fargate-service',
  {
    cluster: ecsCluster.arn,
    taskDefinition: taskDefinition.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    healthCheckGracePeriodSeconds: 60,
    deploymentCircuitBreaker: { enable: true, rollback: true },
    waitForSteadyState: true,
    networkConfiguration: {
      subnets: vpc.publicSubnetIds,
      assignPublicIp: true,
      securityGroups: [ecsSecurityGroup.id]
    },
    loadBalancers: [
      {
        targetGroupArn: targetGroup.arn,
        containerName: 'screencloud-oms',
        containerPort: 3000
      }
    ]
  },
  {
    dependsOn: [listener, albToApp, executionPolicy, secretPolicy, databaseSecretVersion, tokenSecretVersion]
  }
);

// Outputs
export const loadBalancerDnsName = alb.dnsName;
export const apiUrl = `https://${domainName}`;
export const deployedImage = imageUri;
export const imageRepositoryUrl = repository.repositoryUrl;
export const databaseEndpoint = rdsInstance.endpoint;
export const ecsClusterName = ecsCluster.name;
export const fargateServiceName = fargateService.name;
