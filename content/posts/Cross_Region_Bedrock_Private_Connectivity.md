---
title: "Private Cross-Region AWS Bedrock Connectivity with VPC Peering"
date: 2025-12-07T00:00:00Z
draft: true
tags: ['aws', 'bedrock', 'vpc-peering', 'terraform', 'networking', 'ai', 'infrastructure']
---

## The Challenge

AWS Bedrock isn't available in all regions. If you're running your application in a region without Bedrock support (like New Zealand / ap-southeast-6), you face a dilemma: either relocate your entire infrastructure or access Bedrock over the public internet from a supported region like Sydney (ap-southeast-2). 

Public internet access introduces several issues:
- Higher latency and unpredictable network performance
- Security concerns with data traversing the public internet
- NAT Gateway egress charges for outbound traffic
- No network-level isolation

This post walks through building a Terraform module that creates private connectivity between your application VPC in one region and AWS Bedrock services in another region using VPC peering and VPC endpoints.

## Architecture Overview

The solution consists of:

1. **Two VPCs**: One in your application region (NZ), another in the Bedrock-supported region (Sydney)
2. **VPC Peering**: Cross-region peering connection for private connectivity
3. **VPC Endpoints**: Interface endpoints for Bedrock services in Sydney VPC
4. **Route53 Private Hosted Zones**: DNS override to resolve Bedrock hostnames to private IPs
5. **Security Groups**: Access control for the VPC endpoints

```
┌─────────────────────────────────────┐       ┌──────────────────────────────────┐
│  NZ Region (ap-southeast-6)         │       │  Sydney Region (ap-southeast-2)  │
│                                     │       │                                  │
│  ┌─────────────────────────────┐   │       │  ┌──────────────────────────┐   │
│  │  Application VPC            │   │       │  │  Sydney VPC              │   │
│  │  10.0.0.0/16                │   │       │  │  10.1.0.0/16             │   │
│  │                             │   │       │  │                          │   │
│  │  ┌─────────────────────┐   │   │       │  │  ┌──────────────────┐   │   │
│  │  │  ECS Tasks/Fargate  │   │◄──┼───────┼──┼──┤ VPC Endpoints    │   │   │
│  │  │                     │   │   │  VPC  │  │  │ - bedrock        │   │   │
│  │  │  Route53 PHZ:       │   │   │ Peer  │  │  │ - bedrock-runtime│   │   │
│  │  │  bedrock*.aws.com   │   │   │       │  │  │ - bedrock-agent  │   │   │
│  │  │  → 10.1.x.x         │   │   │       │  │  │ - bedrock-agent- │   │   │
│  │  │                     │   │   │       │  │  │   runtime        │   │   │
│  │  └─────────────────────┘   │   │       │  │  └──────────────────┘   │   │
│  └─────────────────────────────┘   │       │  └──────────────────────────┘   │
└─────────────────────────────────────┘       └──────────────────────────────────┘
```

## Why VPC Peering + VPC Endpoints?

**VPC Endpoints** provide private connectivity to AWS services without requiring an internet gateway or NAT device. However, VPC endpoints are region-specific and can only be accessed from within the same VPC or connected VPCs.

**VPC Peering** enables routing between VPCs across regions using AWS's private network backbone. This allows resources in one region to access VPC endpoints in another region privately.

The critical insight: **VPC endpoint private DNS only works within the endpoint's VPC**. Resources in a peered VPC won't automatically resolve the service hostname to the endpoint's private IPs. This is where Route53 Private Hosted Zones come in.

### What About Cross-Region PrivateLink?

You might wonder: "Why not use AWS PrivateLink directly across regions?" 

AWS PrivateLink does support cross-region connectivity through **VPC Endpoint Services**, which would significantly simplify this architecture by eliminating the need for VPC peering, route configuration, and DNS workarounds. With cross-region PrivateLink, you could directly create an interface endpoint in your NZ VPC that connects to AWS services in Sydney.

**However, there's a catch**: Cross-region PrivateLink support is currently limited to specific regions and doesn't yet include many Asia-Pacific regions like New Zealand (ap-southeast-6). As of December 2025, this feature requires both the source and target regions to support cross-region endpoint connections.

Once cross-region PrivateLink becomes available in your regions, the architecture would simplify to:

```
┌─────────────────────────────────────┐
│  NZ Region (ap-southeast-6)         │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  Application VPC            │   │       Cross-Region
│  │                             │   │       PrivateLink
│  │  ┌─────────────────────┐   │   │      (when available)
│  │  │  ECS Tasks          │   │   │           │
│  │  │  └─► VPC Endpoint ──┼───┼───┼───────────┘
│  │  │      (direct to     │   │   │
│  │  │       Sydney        │   │   │
│  │  │       Bedrock)      │   │   │
│  │  └─────────────────────┘   │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘

No VPC peering, no routes, no DNS zones needed!
```

Until then, the VPC peering approach documented in this post remains the most reliable solution for private cross-region connectivity to AWS services.

## The DNS Resolution Challenge

When you create a VPC endpoint with `private_dns_enabled = true`, AWS automatically creates a private hosted zone in that VPC. This works perfectly for resources within the same VPC:

```bash
# From Sydney VPC
$ nslookup bedrock-runtime.ap-southeast-2.amazonaws.com
Address: 10.1.45.123  # Private IP ✓
```

But from the NZ VPC across the peering connection:

```bash
# From NZ VPC (before Route53 PHZ)
$ nslookup bedrock-runtime.ap-southeast-2.amazonaws.com
Address: 13.54.114.61  # Public IP ✗
```

The DNS query returns public IPs because the private DNS zone created by the VPC endpoint doesn't propagate across VPC peering. Your traffic would go over the public internet, defeating the entire purpose of the private connectivity infrastructure.

**Solution**: Create Route53 Private Hosted Zones in the NZ VPC that override DNS resolution for Bedrock service hostnames, pointing them to the Sydney VPC endpoints' private IPs.

## Terraform Module Structure

Let's build a reusable Terraform module. Here's the high-level structure:

```
modules/cross-region-interconnect/
├── main.tf           # VPCs, peering, endpoints, Route53
├── variables.tf      # Input variables
├── locals.tf         # Computed values and logic
├── data.tf           # Data sources for discovery
├── outputs.tf        # Module outputs
└── versions.tf       # Provider requirements
```

### Provider Configuration

We need two AWS provider configurations for multi-region resources:

```hcl
# versions.tf
terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
      configuration_aliases = [aws.nz, aws.sydney]
    }
  }
}
```

### VPC Creation

The module supports both creating new VPCs or using existing ones:

```hcl
# main.tf
module "nz_vpc" {
  count = var.create_nz_vpc ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"
  
  providers = {
    aws = aws.nz
  }
  
  name = "${var.name}-nz"
  cidr = var.nz_vpc_cidr
  
  azs             = data.aws_availability_zones.nz.names
  private_subnets = [for k, v in data.aws_availability_zones.nz.names : 
                     cidrsubnet(var.nz_vpc_cidr, 4, k)]
  public_subnets  = [for k, v in data.aws_availability_zones.nz.names : 
                     cidrsubnet(var.nz_vpc_cidr, 8, k + 48)]
  
  enable_nat_gateway = true
  single_nat_gateway = true
}

module "sydney_vpc" {
  count = var.create_sydney_vpc ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"
  
  providers = {
    aws = aws.sydney
  }
  
  name = "${var.name}-sydney"
  cidr = var.sydney_vpc_cidr
  
  # Similar configuration as NZ VPC
}
```

### VPC Peering

Create a cross-region peering connection:

```hcl
# VPC Peering between NZ and Sydney
resource "aws_vpc_peering_connection" "nz_to_sydney" {
  count = var.create_sydney_vpc ? 1 : 0
  provider = aws.nz
  
  vpc_id      = local.nz_vpc_id
  peer_vpc_id = module.sydney_vpc[0].vpc_id
  peer_region = var.sydney_region
  
  auto_accept = false
}

# Accept peering in Sydney
resource "aws_vpc_peering_connection_accepter" "sydney_accept" {
  count = var.create_sydney_vpc ? 1 : 0
  provider = aws.sydney
  
  vpc_peering_connection_id = aws_vpc_peering_connection.nz_to_sydney[0].id
  auto_accept = true
}
```

### Route Configuration

Add routes in both VPCs to enable traffic flow:

```hcl
# Route from NZ to Sydney
resource "aws_route" "nz_to_sydney" {
  count = var.create_sydney_vpc ? length(local.nz_private_route_table_ids) : 0
  provider = aws.nz
  
  route_table_id            = local.nz_private_route_table_ids[count.index]
  destination_cidr_block    = var.sydney_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.nz_to_sydney[0].id
}

# Route from Sydney to NZ
resource "aws_route" "sydney_to_nz" {
  count = var.create_sydney_vpc ? length(module.sydney_vpc[0].private_route_table_ids) : 0
  provider = aws.sydney
  
  route_table_id            = module.sydney_vpc[0].private_route_table_ids[count.index]
  destination_cidr_block    = var.nz_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.nz_to_sydney[0].id
}
```

### VPC Endpoints for Bedrock Services

Create interface endpoints for all Bedrock services:

```hcl
# Security group for all Bedrock endpoints
resource "aws_security_group" "sydney_bedrock_endpoints" {
  count = var.create_sydney_vpc ? 1 : 0
  provider = aws.sydney
  
  name        = "${var.name}-bedrock-endpoints-sg"
  description = "Security group for Bedrock VPC endpoints"
  vpc_id      = module.sydney_vpc[0].vpc_id
  
  ingress {
    description = "HTTPS from NZ VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.nz_vpc_cidr]
  }
  
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Bedrock Runtime endpoint
resource "aws_vpc_endpoint" "bedrock_runtime" {
  count = var.create_sydney_vpc ? 1 : 0
  provider = aws.sydney
  
  vpc_id              = module.sydney_vpc[0].vpc_id
  service_name        = "com.amazonaws.${var.sydney_region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.sydney_vpc[0].private_subnets
  security_group_ids  = [aws_security_group.sydney_bedrock_endpoints[0].id]
  private_dns_enabled = true
}

# Repeat for bedrock, bedrock-agent, bedrock-agent-runtime endpoints
```

### Route53 Private Hosted Zones (The Critical Part)

Create private hosted zones in the NZ VPC to override DNS resolution:

```hcl
# Private Hosted Zone for Bedrock Runtime
resource "aws_route53_zone" "bedrock_runtime_private_zone" {
  count = var.create_sydney_vpc ? 1 : 0
  provider = aws.nz
  
  name = "bedrock-runtime.${var.sydney_region}.amazonaws.com"
  
  vpc {
    vpc_id = local.nz_vpc_id
  }
}

# DNS record pointing to VPC endpoint
resource "aws_route53_record" "bedrock_runtime_endpoint" {
  count = var.create_sydney_vpc ? 1 : 0
  provider = aws.nz
  
  zone_id = aws_route53_zone.bedrock_runtime_private_zone[0].zone_id
  name    = "bedrock-runtime.${var.sydney_region}.amazonaws.com"
  type    = "A"
  
  alias {
    name                   = aws_vpc_endpoint.bedrock_runtime[0].dns_entry[0].dns_name
    zone_id                = aws_vpc_endpoint.bedrock_runtime[0].dns_entry[0].hosted_zone_id
    evaluate_target_health = true
  }
}

# Repeat for other Bedrock services:
# - bedrock.ap-southeast-2.amazonaws.com
# - bedrock-agent.ap-southeast-2.amazonaws.com
# - bedrock-agent-runtime.ap-southeast-2.amazonaws.com
```

**Why separate hosted zones?** Each Bedrock service has its own subdomain (e.g., `bedrock.amazonaws.com`, `bedrock-runtime.amazonaws.com`). Route53 Private Hosted Zones require exact domain matching - you can't use wildcards. Therefore, each service needs its own hosted zone.

### Smart Logic for Existing VPCs

Use locals to handle both new and existing VPC scenarios:

```hcl
# locals.tf
locals {
  nz_vpc_id = var.create_nz_vpc ? module.nz_vpc[0].vpc_id : var.nz_vpc_id
  
  # Auto-discover route tables if not provided
  nz_private_route_table_ids = var.create_nz_vpc ? (
    module.nz_vpc[0].private_route_table_ids
  ) : (
    length(var.nz_private_route_table_ids) > 0 ? 
    var.nz_private_route_table_ids : 
    data.aws_route_tables.nz_private[0].ids
  )
}
```

```hcl
# data.tf
data "aws_route_tables" "nz_private" {
  count = var.create_nz_vpc ? 0 : (length(var.nz_private_route_table_ids) == 0 ? 1 : 0)
  provider = aws.nz
  
  vpc_id = var.nz_vpc_id
  
  filter {
    name   = "association.main"
    values = ["false"]
  }
}
```

## Using the Module

### Example: Using Existing NZ VPC

```hcl
# main.tf
provider "aws" {
  alias  = "nz"
  region = "ap-southeast-6"
}

provider "aws" {
  alias  = "sydney"
  region = "ap-southeast-2"
}

module "cross_region_interconnect" {
  source = "./modules/cross-region-interconnect"
  
  providers = {
    aws.nz     = aws.nz
    aws.sydney = aws.sydney
  }
  
  name          = "myapp"
  sydney_region = "ap-southeast-2"
  
  # Use existing NZ VPC
  create_nz_vpc             = false
  nz_vpc_id                 = "vpc-0123456789abcdef0"
  nz_vpc_cidr               = "10.0.0.0/16"
  nz_private_subnet_ids     = ["subnet-abc123", "subnet-def456"]
  # Route tables auto-discovered if not provided
  
  # Create new Sydney VPC
  create_sydney_vpc = true
  sydney_vpc_cidr   = "10.1.0.0/16"
}
```

## Verification

After applying the infrastructure, verify DNS resolution from your NZ VPC:

```bash
# SSH into an ECS task or EC2 instance in NZ VPC
$ nslookup bedrock-runtime.ap-southeast-2.amazonaws.com

Server:  10.0.0.2
Address: 10.0.0.2#53

Name:    bedrock-runtime.ap-southeast-2.amazonaws.com
Address: 10.1.45.123  # Private IP from Sydney VPC endpoint ✓
```

Test connectivity:

```bash
# Using AWS CLI from NZ VPC
$ aws bedrock-runtime invoke-model \
  --model-id anthropic.claude-v2 \
  --region ap-southeast-2 \
  --body '{"prompt":"Hello","max_tokens":100}' \
  output.txt

# Check VPC Flow Logs to confirm traffic flows through peering
$ aws ec2 describe-flow-logs --region ap-southeast-6
```

## Cost Considerations

- **VPC Peering**: No charges for peering connection itself; pay for cross-region data transfer (~$0.02/GB)
- **VPC Endpoints**: ~$0.01/hour per AZ per endpoint (~$7.20/month per endpoint for 1 AZ)
- **Route53 Private Hosted Zones**: $0.50/month per zone (4 zones = $2/month)
- **NAT Gateway**: Saved egress charges by avoiding public internet traffic

**Total monthly cost estimate**: ~$30-40/month for private connectivity infrastructure, but savings on NAT Gateway egress can be substantial depending on traffic volume.

## Key Takeaways

1. **VPC endpoint private DNS doesn't cross VPC peering boundaries** - this is the gotcha that took debugging to discover
2. **Route53 Private Hosted Zones solve cross-VPC DNS** by overriding resolution for specific domains
3. **Each Bedrock service subdomain requires its own private hosted zone** - no wildcard support
4. **Auto-discovery of route tables** makes the module more flexible when using existing VPCs
5. **Security groups on endpoints** ensure only authorized VPCs can access the endpoints

## Conclusion

Building private cross-region connectivity for AWS services requires careful consideration of networking, routing, and DNS resolution. The combination of VPC peering, VPC endpoints, and Route53 Private Hosted Zones provides a robust solution that keeps traffic on AWS's private network while maintaining regional flexibility.

The key insight is understanding that private DNS is VPC-scoped, not peering-scoped. By explicitly creating private hosted zones in the application VPC with alias records to the remote endpoints, we achieve transparent private connectivity that "just works" for applications without any code changes.

While this approach works well today, keep an eye on AWS's cross-region PrivateLink expansion. Once it becomes available in your regions, migrating to that native solution would significantly simplify the architecture by removing the need for VPC peering infrastructure and DNS overrides. Until then, the pattern described here provides a production-ready, secure, and cost-effective way to access regional AWS services privately from anywhere in the AWS network.

---

**References**:
- [AWS VPC Peering Documentation](https://docs.aws.amazon.com/vpc/latest/peering/)
- [AWS VPC Endpoints Documentation](https://docs.aws.amazon.com/vpc/latest/privatelink/)
- [Route53 Private Hosted Zones](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-private.html)
- [AWS Bedrock Regions](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html#bedrock-regions)
