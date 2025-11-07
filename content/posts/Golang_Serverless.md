---
title: "Using Golang, AWS Lambda serverless function, SNS & EventBridge for stock notification."
slug: "using-golang-aws-lambda-serverless-function-sns-and-eventbridge-for-stock-notification"
date: 2022-05-28
updated: 2025-07-19
tags:
  - golang
  - serverless
---

This guide explains how to write an AWS Lambda serverless function in Go that is triggered by an Amazon EventBridge rule on a schedule. The function checks product stock levels and sends an email notification if stock drops below a specified threshold.

## Overview
We’ll use Go to implement a Lambda function that:
- Is triggered by an EventBridge scheduled rule
- Checks product inventory (e.g., from Shopify)
- Sends email notifications when stock is low, using AWS SNS

## Lambda function in Go

Using the AWS SDK for Go, you can easily create the Lambda handler and integrate with AWS SNS for email notifications.

Before writing the function, be sure to:

Set up required Shopify environment variables (e.g., API key, store URL)

Fetch product inventory from the Shopify API

```go:main.go
package main

import(
    "os"
    "io/ioutil"
    "net/http"
)
func HandleRequest() {
    //Lambda environment variable
    apiKey := os.Getenv("SHOPIFY_API_KEY")
    password := os.Getenv("SHOPIPY_API_PASSWORD")	
    domain := os.Getenv("SHOPIFY_SHOPIFY_DOMAIN")

    url := fmt.Sprintf("https://%s:%s@%s.myshopify.com/admin/api/2022-04/products.json", apiKey, password, domain)

    resp, err := http.Get(url)
    if err != nil {
        panic(err)
    }

    defer resp.Body.Close()

    bytes, err := ioutil.ReadAll(resp.Body)
    if err != nil {
        panic(err)
    }
}
func main() {
    lambda.Start(HandleRequest)
}
```

Extracting Product SKU of the which stock is below 10.

	
```go:main.go
import(
    "os"
    "io/ioutil"
    "net/http"
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "strings"
)

func HandleRequest() {
    //Lambda environment variable
    apiKey := os.Getenv("SHOPIFY_API_KEY")
    password := os.Getenv("SHOPIPY_API_PASSWORD")	
    domain := os.Getenv("SHOPIFY_SHOPIFY_DOMAIN")

    url := fmt.Sprintf("https://%s:%s@%s.myshopify.com/admin/api/2022-04/products.json", apiKey, password, domain)

    resp, err := http.Get(url)
    if err != nil {
        panic(err)
    }

    defer resp.Body.Close()

    bytes, err := ioutil.ReadAll(resp.Body)
    if err != nil {
        panic(err)
    }

    var products map[string]interface{}
    if err := json.NewDecoder(req.Body).Decode(&bytes); err != nil {
        panic(err)
    } 

    skuToStock := []string{}

    for _, productData := range products {
	    for _, products := range productData.([]interface{}) {
		    for key, product := range products.(map[string]interface{}) {
			    if key == "variants" {
				    for _, variant := range product.([]interface{}) {
					    if variant.(map[string]interface{})["inventory_quantity"].(float64) <= 10 {
						    sku := variant.(map[string]interface{})["SKU"]
						    skuToStock = append(skuToStock, sku.(string))
					     }
				    }
			    }
		    }
	    }
    }
}
```

Using AWS SDK to send notification

```go:main.go
import(
    "os"
    "io/ioutil"
    "net/http"
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "strings"
    "github.com/aws/aws-lambda-go/lambda"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/sns"
)

type SNSPublishAPI interface {
	Publish(ctx context.Context,
		params *sns.PublishInput,
		optFns ...func(*sns.Options)) (*sns.PublishOutput, error)
}

func PublishMessage(c context.Context, api SNSPublishAPI, input *sns.PublishInput) (*sns.PublishOutput, error) {
	return api.Publish(c, input)
}

func HandleRequest() {
    //Lambda environment variable
    apiKey := os.Getenv("SHOPIFY_API_KEY")
    password := os.Getenv("SHOPIPY_API_PASSWORD")	
    domain := os.Getenv("SHOPIFY_SHOPIFY_DOMAIN")

    url := fmt.Sprintf("https://%s:%s@%s.myshopify.com/admin/api/2022-04/products.json", apiKey, password, domain)

    resp, err := http.Get(url)
    if err != nil {
        panic(err)
    }

    defer resp.Body.Close()

    bytes, err := ioutil.ReadAll(resp.Body)
    if err != nil {
        panic(err)
    }

    var products map[string]interface{}
    if err := json.NewDecoder(req.Body).Decode(&bytes); err != nil {
        panic(err)
    }

    skuToStock := []string{}

    for _, productData := range products {
	    for _, products := range productData.([]interface{}) {
		    for key, product := range products.(map[string]interface{}) {
			    if key == "variants" {
				    for _, variant := range product.([]interface{}) {
					    if variant.(map[string]interface{})["inventory_quantity"].(float64) <= 10 {
						    sku := variant.(map[string]interface{})["SKU"]
						    skuToStock = append(skuToStock, sku.(string))
					     }
				    }
			    }
		    }
	    }
    }

    if len(skuToStock) > 0 {
	    snsMessage := strings.Join(skuToStock, ",")
	    topicARN := "<lambda-arn>"

	    cfg, err := config.LoadDefaultConfig(context.TODO())

	    if err != nil {
	            panic("configuration error, " + err.Error())
	    }

	    client := sns.NewFromConfig(cfg)
	    input := &sns.PublishInput{
		    Message:  &snsMessage,
		    TopicArn: &topicARN,
	    }

	    result, err := PublishMessage(context.TODO(), client, input)
	    if err != nil {
		    fmt.Println("Got an error publishing the message:")
		    fmt.Println(err)
	    }

	    fmt.Println("Message ID: " + *result.MessageId)
    }
}
```


## Prerequisites - AWS CLI & AWS Shell

**AWS Command Line Interface(CLI)** is used to deploy the Lambda function. CLI needs to be [installed](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and [configured](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-configure.html) locally in order to use it.

**[AWS Shell](https://github.com/awslabs/aws-shell)** provides helpful features like auto-completion and fuzzy searching to enhance your CLI experience.


## How to deploy it on AWS

We'll upload the Go binary to AWS Lambda as a .zip file. In order to [build for Linux](https://github.com/aws/aws-lambda-go/blob/main/README.md#building-your-function), we're using the following command. 

```bash
GOOS=linux GOARCH=amd64 go build -o main main.go
zip main.zip main
```
### Creating IAM roles & policies.

Create the `assume-role-policy.json` file:

```json:assume-role-policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "lambda.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```
Create an IAM role

```shell:shell
iam create-role --role-name role-lambda-shopify --assume-role-policy-document file://assume-role-policy.json
```

```json:response
{
    "Role": {
        "Path": "/",
        "RoleName": "role-lambda-shopify",
        "RoleId": "AROARKDOZJ3E6FZQIORPR",
        "Arn": "arn:aws:iam::090426658505:role/role-lambda-shopify",
        "CreateDate": "2022-06-25T21:30:57Z",
        "AssumeRolePolicyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "lambda.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }
    }
}
```

Let's attach permission to this role. **AWSLambdaBasicExecutionRole** gives permission to write logs to cloudWatch.

```shell
iam attach-role-policy --role-name role-lambda-shopify --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Create an SNS topic

```shell
sns create-topic --name shopify-stock-notification
```

```json:response
{
    "TopicArn": "arn:aws:sns:ap-southeast-2:090426658505:shopify-stock-notification"
}
```

To subscribe to the SNS topic:

```shell
sns subscribe --topic-arn arn:aws:sns:ap-southeast-2:090426658505:shopify-stock-notification --protocol email --notification-endpoint test@hotmail.com
```

we're going to attach an inline policy that grants access to the Lambda function to trigger SNS notification.

```json:sns-policy-for-lambda.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:ap-southeast-2:090426658505:shopify-stock-notification"
    }
  ]
}

```

```shell
iam put-role-policy --role-name role-lambda-shopify --policy-name publish-to-sns --policy-document file://sns-policy-for-lambda.json
```

Create/Update Lambda function

```shell
lambda create-function --function-name function-lambda-shopify-stock --zip-file fileb://main.zip --handler main --runtime go1.x --role arn:aws:iam::090426658505:role/role-lambda-shopify
```

```json:response
{
    "FunctionName": "function-lambda-shopify-stock",
    "FunctionArn": "arn:aws:lambda:ap-southeast-2:090426658505:function:function-lambda-shopify-stock",
    "Runtime": "go1.x",
    "Role": "arn:aws:iam::090426658505:role/role-lambda-shopify",
    "Handler": "main",
    "CodeSize": 6662556,
    "Description": "",
    "Timeout": 3,
    "MemorySize": 128,
    "LastModified": "2022-06-25T22:04:02.491+0000",
    "CodeSha256": "uLsOQEp4VCFi294HpbKyl1i60uLGUIBwmpI2cg0wdeU=",
    "Version": "$LATEST",
    "TracingConfig": {
        "Mode": "PassThrough"
    },
    "RevisionId": "1ff52d69-6429-49d8-ba7f-492886e9aee3",
    "State": "Pending",
    "StateReason": "The function is being created.",
    "StateReasonCode": "Creating",
    "PackageType": "Zip",
    "Architectures": [
        "x86_64"
    ],
    "EphemeralStorage": {
        "Size": 512
    }
}
```

To add environmental variable to Lambda function:

```shell
lambda update-function-configuration --function-name function-lambda-shopify-stock --environment "Variables={SHOPIFY_API_KEY=<your-shopify-key>, SHOPIPY_API_PASSWORD=<your-shopify-password>, SHOPIFY_SHOPIFY_DOMAIN=c<your-shopify-domain>}”
```

To update the Lambda function: 

```shell
lambda update-function-code --function-name function-lambda-shopify-stock --zip-file fileb://main.zip
```

To invoke the Lambda function and store the output to a text file:

```shell
lambda invoke --function-name function-lambda-shopify-stock output.txt
```

## EventBridge scheduler

EventBridge rule let you create a cron that triggers the Lambda function.

![image](/images/eventbridge-rule-2.png)

![image](/images/eventbridge-schedule.png)

![image](/images/eventbridge-rule.png)



The code is available in [Github repo](https://github.com/ItsVigneshMurugan/go-aws-lambda-shopify)